// Approved-customer onboarding for AirPlain.
// Applications remain requests until an owner explicitly approves them.
// All persistence uses D1; no raw customer message text or OAuth credentials
// are returned by the API. Live provider connections require Cloudflare secrets.
import { decide } from "./engine.js";
import { defaultSettings } from "./store.js";
import { sanitizeText } from "./guardrails.js";

const MS_DAY = 86400000;
const ROUTES = ["answer_now", "book_time", "flag_owner", "file_away"];
const COOKIE = "ap_setup_session";

function respond(value, status = 200, extras = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extras },
  });
}
function error(message, status = 400) { return respond({ ok: false, error: message }, status); }
function nowIso() { return new Date().toISOString(); }
function expireAfter(days) { return new Date(Date.now() + days * MS_DAY).toISOString(); }
function randomUrlToken() {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return base64url(data);
}
function base64url(bytes) {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Script clients still need the secret or session.
  return origin === new URL(request.url).origin;
}
function secureCompare(a,b) {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  for(let i=0;i<Math.max(aa.length,bb.length);i++) diff |= (aa[i]||0) ^ (bb[i]||0);
  return diff === 0;
}
function dbOrError(env) {
  if (!env.AIRPLAIN_DB?.prepare) return null;
  return env.AIRPLAIN_DB;
}
function sessionToken(request) {
  const found = (request.headers.get("cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE+"="));
  const token = found?.slice(COOKIE.length+1) || "";
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : "";
}
async function activeCustomer(request, db) {
  const raw = sessionToken(request);
  if (!raw) return null;
  const digest = await sha(raw);
  const row = await db.prepare(
    "SELECT p.*, a.name, a.business, a.email, a.fare, a.preferred_seat FROM onboarding_sessions s JOIN onboarding_profiles p ON p.signup_id=s.signup_id JOIN pilot_signups a ON a.id=p.signup_id WHERE s.token_hash=? AND s.expires_at>? AND p.status='approved'"
  ).bind(digest,nowIso()).first();
  return row || null;
}
function authorizedAdmin(request,env) {
  const expected = String(env.AIRPLAIN_ADMIN_KEY || "");
  const auth = request.headers.get("authorization") || "";
  return expected.length >= 32 && auth.startsWith("Bearer ") && secureCompare(auth.slice(7),expected);
}
function audit(db,id,action) {
  return db.prepare("INSERT INTO onboarding_events (id,signup_id,action,created_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), id, action, nowIso()).run();
}
function progressFromRow(row) {
  const connected = Boolean((row.gmail_address && row.gmail_connected_at) || (row.microsoft_address && row.microsoft_connected_at));
  const routes = Boolean(row.preferences_saved_at);
  const approved = Boolean(row.rules_approved_at);
  const tested = Boolean(row.last_test_at && row.last_test_engine === "workers-ai");
  return { connected, routes, approved, tested, completed: [connected,routes,approved,tested].filter(Boolean).length };
}
function publicStatus(row,env) {
  let routes = {};
  try { routes = JSON.parse(row.routes_json || "{}"); } catch { routes = {}; }
  return {
    ok:true,
    customer: { name:row.name,business:row.business, fare:row.fare, seat_preference:row.preferred_seat || null, application_reference:row.signup_id, approved_at:row.approved_at || null },
    gmail: { connected: Boolean(row.gmail_address && row.gmail_connected_at), address:row.gmail_address || null,available:providerReady(env) },
    microsoft: { connected: Boolean(row.microsoft_address && row.microsoft_connected_at), address:row.microsoft_address || null,available:microsoftReady(env) },
    preferences:routes,
    rules: { text:row.rules_text || "", approved_at:row.rules_approved_at || null },
    last_test:row.last_test_at ? { engine:row.last_test_engine, result:JSON.parse(row.last_test_result || "{}"), at:row.last_test_at } : null,
    progress: progressFromRow(row),
    notice:"No messages are imported, sent, or automatically handled during preflight. Both provider permissions are read-only."
  };
}
async function bodyJson(request) {
  if(!(request.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await request.json(); } catch { return null; }
}
function clearCookie() { return COOKIE+"=; HttpOnly; Secure; SameSite=Lax; Path=/api/setup; Max-Age=0"; }

async function adminList(db) {
  const results = await db.prepare(
    "SELECT a.id,a.name,a.business,a.email,a.where_piled_up,a.fare,a.preferred_seat,a.created_at,COALESCE(p.status,'pending') AS status,p.approved_at,p.declined_at FROM pilot_signups a LEFT JOIN onboarding_profiles p ON p.signup_id=a.id ORDER BY a.created_at DESC LIMIT 100"
  ).all();
  return respond({ok:true,applications:results.results || []});
}
async function adminChange(request,db,decision,env) {
  const body = await bodyJson(request);
  const id = sanitizeText(body?.application_id,100);
  if (!id) return error("Choose an application.",400);
  const app = await db.prepare("SELECT id,name,business,email FROM pilot_signups WHERE id=?").bind(id).first();
  if (!app) return error("That application was not found.",404);
  if (decision==="decline") {
    // Disconnect local access on rejection, even if the OAuth revocation service is unreachable.
    const previous=await db.prepare("SELECT gmail_refresh_encrypted,microsoft_refresh_encrypted FROM onboarding_profiles WHERE signup_id=?").bind(id).first();
    let revokeWarning=null;
    if(previous?.gmail_refresh_encrypted){
      try{
        const token=await decryptRefresh(previous.gmail_refresh_encrypted,env);
        const response=await fetch("https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token})});
        if(!response.ok && response.status!==400)revokeWarning="Customer should revoke AirPlain in Google Account permissions.";
      }catch{revokeWarning="Customer should revoke AirPlain in Google Account permissions.";}
    }
    if(previous?.microsoft_refresh_encrypted)revokeWarning=[revokeWarning,"Ask the customer to withdraw AirPlain access in their Microsoft account permissions."].filter(Boolean).join(" ");
    await db.prepare("INSERT INTO onboarding_profiles (signup_id,status,declined_at) VALUES (?,'declined',?) ON CONFLICT(signup_id) DO UPDATE SET status='declined',declined_at=excluded.declined_at,approved_at=NULL,gmail_address=NULL,gmail_refresh_encrypted=NULL,gmail_connected_at=NULL,microsoft_address=NULL,microsoft_refresh_encrypted=NULL,microsoft_connected_at=NULL,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL").bind(id,nowIso()).run();
    await db.prepare("DELETE FROM onboarding_invites WHERE signup_id=?").bind(id).run();
    await db.prepare("DELETE FROM onboarding_sessions WHERE signup_id=?").bind(id).run();
    await db.prepare("DELETE FROM onboarding_oauth_states WHERE signup_id=?").bind(id).run();
    await audit(db,id,"application_declined");
    return respond({ok:true,status:"declined",warning:revokeWarning});
  }
  await db.prepare("INSERT INTO onboarding_profiles (signup_id,status,approved_at) VALUES (?,'approved',?) ON CONFLICT(signup_id) DO UPDATE SET status='approved',approved_at=excluded.approved_at,declined_at=NULL").bind(id,nowIso()).run();
  await db.prepare("DELETE FROM onboarding_invites WHERE signup_id=?").bind(id).run();
  const token=randomUrlToken(), digest=await sha(token), expires=expireAfter(7);
  await db.prepare("INSERT INTO onboarding_invites (id,signup_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),id,digest,expires,nowIso()).run();
  await audit(db,id,"application_approved_invite_issued");
  // The raw invite is intentionally returned ONCE, never stored.
  const origin = configuredOrigin(env) || new URL(request.url).origin;
  return respond({ok:true,status:"approved",customer:app.name,email:app.email,expires_at:expires,
    invitation_url:origin+"/setup/#invite="+token,
    instruction:"Copy this invitation and send it privately to the approved applicant. It expires in 7 days, can be used only once, and does not charge the customer."});
}
async function claimInvite(request,db) {
  const body=await bodyJson(request);
  const token=String(body?.token || "");
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(token))return error("This invitation is invalid.",400);
  const digest=await sha(token),now=nowIso();
  const invite=await db.prepare("SELECT i.id,i.signup_id FROM onboarding_invites i JOIN onboarding_profiles p ON p.signup_id=i.signup_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>? AND p.status='approved'").bind(digest,now).first();
  if(!invite)return error("This invitation has expired or has already been used. Ask AirPlain for a new link.",401);
  const changed=await db.prepare("UPDATE onboarding_invites SET used_at=? WHERE id=? AND used_at IS NULL").bind(now,invite.id).run();
  if(changed.meta && changed.meta.changes !== 1)return error("That invitation has already been used.",401);
  const session=randomUrlToken(),sessionHash=await sha(session);
  await db.prepare("INSERT INTO onboarding_sessions (id,signup_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),invite.signup_id,sessionHash,expireAfter(30),now).run();
  await audit(db,invite.signup_id,"invite_claimed");
  return respond({ok:true,message:"You're approved. Let's get AirPlain ready."},200,{"set-cookie":COOKIE+"="+session+"; HttpOnly; Secure; SameSite=Lax; Path=/api/setup; Max-Age="+(30*86400)});
}

function validateRoutes(input) {
  if(!input || typeof input!=="object" || Array.isArray(input))return null;
  const out={};
  for(const label of ["billing","appointments","sales","general"]) {
    if(!ROUTES.includes(input[label]))return null;
    out[label]=input[label];
  }
  return out;
}
async function savePreferences(request,db,row) {
  const b=await bodyJson(request), routes=validateRoutes(b?.routes);
  if(!routes)return error("Choose one valid action for Billing, Appointments, Sales, and General messages.");
  const special=sanitizeText(b?.special_instructions,400);
  const values={...routes,special_instructions:special};
  await db.prepare("UPDATE onboarding_profiles SET routes_json=?,preferences_saved_at=?,rules_approved_at=NULL,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=?")
    .bind(JSON.stringify(values),nowIso(),row.signup_id).run();
  await audit(db,row.signup_id,"routing_preferences_saved");
  return respond({ok:true,preferences:values,message:"Routing preferences saved. Rules must be approved again after any change."});
}
async function approveRules(request,db,row) {
  if(!row.preferences_saved_at)return error("Save your routing preferences first.",409);
  const b=await bodyJson(request);
  if(b?.approve !== true)return error("Please explicitly approve the rules.",400);
  const instructions=sanitizeText(b?.instructions,500);
  const disclaimer="Human review required. Do not send customer replies automatically. Always flag urgent messages.";
  await db.prepare("UPDATE onboarding_profiles SET rules_text=?,rules_approved_at=?,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=?")
    .bind(disclaimer+(instructions?" Additional instructions: "+instructions:""),nowIso(),row.signup_id).run();
  await audit(db,row.signup_id,"safety_rules_approved");
  return respond({ok:true,message:"Rules approved and saved. AirPlain will not automatically respond to customers."});
}
async function runSample(request,db,row,env) {
  if(!(row.gmail_connected_at || row.microsoft_connected_at))return error("Connect Gmail or Outlook/Microsoft 365 before running your preflight test.",409);
  if(!row.preferences_saved_at || !row.rules_approved_at)return error("Save routing preferences and approve the rules first.",409);
  const b=await bodyJson(request),sample=sanitizeText(b?.message,1200);
  if(sample.length<8)return error("Enter a short example customer message.",400);
  const options=["Answer now","Book a time","Flag for owner","File away"];
  const settings=defaultSettings();
  settings.criteria = "For a sample customer message, choose one safe routing recommendation. Never send a reply. Owner review is always required. Customer rules: "+row.rules_text;
  const outcome=await decide(env,{kind:"pick",question:sample,context:"This is an onboarding test only. Actions: "+options.join(", ")+".",options},settings);
  if(outcome.ok===false)return error("AirPlain could not process the sample. No action was taken.",502);
  const aiReal=outcome.engine==="workers-ai";
  const safeResult={pick:outcome.pick,confidence:outcome.confidence,explanation:outcome.explanation,engine:outcome.engine,
    warning:outcome.warning || null,automatic_action:false};
  await db.prepare("UPDATE onboarding_profiles SET last_test_engine=?,last_test_result=?,last_test_at=? WHERE signup_id=?")
    .bind(outcome.engine,JSON.stringify(safeResult),nowIso(),row.signup_id).run();
  await audit(db,row.signup_id,aiReal?"real_ai_sample_processed":"fallback_demo_sample_processed");
  return respond({ok:true,real_ai:aiReal,result:safeResult,
    message:aiReal?"Sample processed by Workers AI. No message was sent.":"This was a local fallback demonstration, not a verified AI run. Check the Workers AI binding before marking testing complete."});
}
function configuredOrigin(env) {
  try{
    const u=new URL(String(env.PUBLIC_BASE_URL||""));
    if(u.protocol!=="https:" || u.pathname!=="/" || u.search || u.hash) return null;
    return u.origin;
  }catch{return null;}
}
function providerReady(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OAUTH_ENCRYPTION_KEY && configuredOrigin(env));
}
function microsoftReady(env) {
  return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.OAUTH_ENCRYPTION_KEY && configuredOrigin(env));
}
async function keyFromEnv(env) {
  const raw=String(env.OAUTH_ENCRYPTION_KEY||"");
  let bytes;
  try{bytes=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));}catch{return null;}
  if(bytes.length!==32)return null;
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptRefresh(value,env) {
  const key=await keyFromEnv(env);if(!key)throw new Error("Encrypted token storage is not configured.");
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value));
  return base64url(iv)+"."+base64url(new Uint8Array(cipher));
}
function decodeUrl64(value) {
  const str=value.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(str+"=".repeat((4-str.length%4)%4)),c=>c.charCodeAt(0));
}
async function decryptRefresh(value,env) {
  const key=await keyFromEnv(env);if(!key)throw new Error("Encrypted token storage is not configured.");
  const [a,b]=String(value||"").split(".");
  if(!a||!b)throw new Error("No valid provider token is stored.");
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:decodeUrl64(a)},key,decodeUrl64(b)));
}
function gmailRedirect(env) {
  return String(env.PUBLIC_BASE_URL||"").replace(/\/+$/,"")+"/api/setup/gmail/callback";
}
async function gmailStart(request,db,row,env) {
  if(configuredOrigin(env) && new URL(request.url).origin!==configuredOrigin(env))return error("Open preflight on the official AirPlain website to connect Gmail.",409);
  if(!providerReady(env) || !(await keyFromEnv(env)))return error("Gmail authorization is not configured yet. Please contact AirPlain.",503);
  const state=randomUrlToken(),verifier=randomUrlToken(),digest=await sha(state);
  await db.prepare("INSERT INTO onboarding_oauth_states (state_hash,signup_id,provider,verifier,expires_at,created_at) VALUES (?,?,?,?,?,?)")
    .bind(digest,row.signup_id,"gmail",verifier,new Date(Date.now()+10*60000).toISOString(),nowIso()).run();
  const challenge=base64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  const params=new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,redirect_uri:gmailRedirect(env),response_type:"code",
    scope:"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type:"offline",prompt:"consent",state,code_challenge:challenge,code_challenge_method:"S256"
  });
  return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+params.toString(),302);
}
async function gmailCallback(request,db,env) {
  const u=new URL(request.url),state=u.searchParams.get("state")||"",code=u.searchParams.get("code")||"";
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(state)||!code || !providerReady(env))return Response.redirect(u.origin+"/setup/?error=authorization",302);
  if(u.origin!==configuredOrigin(env))return error("Use AirPlain's official website to finish Gmail setup.",409);
  const digest=await sha(state);
  const record=await db.prepare("SELECT o.state_hash,o.signup_id,o.verifier FROM onboarding_oauth_states o JOIN onboarding_profiles p ON p.signup_id=o.signup_id WHERE o.state_hash=? AND o.provider='gmail' AND o.expires_at>? AND p.status='approved'").bind(digest,nowIso()).first();
  const customer=await activeCustomer(request,db);
  if(!record || !customer || customer.signup_id!==record.signup_id)return Response.redirect(u.origin+"/setup/?error=expired",302);
  const changed=await db.prepare("DELETE FROM onboarding_oauth_states WHERE state_hash=? AND provider='gmail'").bind(digest).run();
  if(changed.meta && changed.meta.changes!==1)return Response.redirect(u.origin+"/setup/?error=expired",302);
  const tokenRes=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      redirect_uri:gmailRedirect(env),grant_type:"authorization_code",code_verifier:record.verifier})
  });
  if(!tokenRes.ok)return Response.redirect(u.origin+"/setup/?error=authorization",302);
  const token=await tokenRes.json();
  if(!token.access_token || !token.refresh_token || !(token.scope||"").includes("gmail.readonly"))return Response.redirect(u.origin+"/setup/?error=permission",302);
  const profileRes=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {headers:{authorization:"Bearer "+token.access_token}});
  if(!profileRes.ok)return Response.redirect(u.origin+"/setup/?error=permission",302);
  const profile=await profileRes.json();
  if(!profile.emailAddress)return Response.redirect(u.origin+"/setup/?error=permission",302);
  const cipher=await encryptRefresh(token.refresh_token,env);
  await db.prepare("UPDATE onboarding_profiles SET gmail_address=?,gmail_refresh_encrypted=?,gmail_connected_at=?,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=? AND status='approved'")
    .bind(sanitizeText(profile.emailAddress,254),cipher,nowIso(),record.signup_id).run();
  await audit(db,record.signup_id,"gmail_readonly_authorized");
  return Response.redirect(u.origin+"/setup/?connected=gmail",302);
}
async function gmailDisconnect(db,row,env) {
  if(row.gmail_refresh_encrypted){
    // No fabricated disconnect: revoke the provider grant before removing the local record.
    let token;
    try{token=await decryptRefresh(row.gmail_refresh_encrypted,env);}catch{return error("Unable to read the saved authorization. Contact AirPlain to revoke your Google access.",503);}
    let res;
    try{res=await fetch("https://oauth2.googleapis.com/revoke",{method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token})});}
    catch{return error("Google could not be reached. Please try again, or revoke AirPlain in your Google account.",503);}
    if(!res.ok && res.status!==400)return error("Google did not confirm revocation. Try again or revoke AirPlain in your Google account.",503);
  }
  await db.prepare("UPDATE onboarding_profiles SET gmail_address=NULL,gmail_refresh_encrypted=NULL,gmail_connected_at=NULL,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=?").bind(row.signup_id).run();
  await audit(db,row.signup_id,"gmail_disconnected");
  return respond({ok:true,message:"Gmail connection removed. No messages were imported or sent."});
}


// Microsoft Graph delegated, read-only email OAuth.
// The Microsoft app registration must support work/school AND personal accounts.
function microsoftRedirect(env) {
  return configuredOrigin(env)+"/api/setup/microsoft/callback";
}
async function microsoftStart(request,db,row,env) {
  if(!microsoftReady(env) || !(await keyFromEnv(env)))
    return error("Outlook/Microsoft 365 authorization is not configured yet. Please contact AirPlain.",503);
  if(new URL(request.url).origin!==configuredOrigin(env))
    return error("Open preflight on the official AirPlain website to connect Outlook.",409);
  const state=randomUrlToken(),verifier=randomUrlToken(),digest=await sha(state);
  await db.prepare("INSERT INTO onboarding_oauth_states (state_hash,signup_id,provider,verifier,expires_at,created_at) VALUES (?,?,?,?,?,?)")
    .bind(digest,row.signup_id,"microsoft",verifier,new Date(Date.now()+10*60000).toISOString(),nowIso()).run();
  const challenge=base64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  const params=new URLSearchParams({
    client_id:String(env.MICROSOFT_CLIENT_ID),response_type:"code",response_mode:"query",
    redirect_uri:microsoftRedirect(env),
    scope:"offline_access User.Read Mail.Read",state,
    code_challenge:challenge,code_challenge_method:"S256",prompt:"select_account"
  });
  return Response.redirect("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"+params.toString(),302);
}
async function microsoftCallback(request,db,env) {
  const u=new URL(request.url),base=configuredOrigin(env);
  if(!microsoftReady(env) || !base || u.origin!==base)
    return error("Microsoft sign-in is not configured for this website.",503);
  const state=u.searchParams.get("state")||"",code=u.searchParams.get("code")||"";
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !code)
    return Response.redirect(base+"/setup/?error=microsoft_authorization",302);
  const digest=await sha(state);
  const record=await db.prepare("SELECT o.state_hash,o.signup_id,o.verifier FROM onboarding_oauth_states o JOIN onboarding_profiles p ON p.signup_id=o.signup_id WHERE o.state_hash=? AND o.provider='microsoft' AND o.expires_at>? AND p.status='approved'")
    .bind(digest,nowIso()).first();
  const customer=await activeCustomer(request,db);
  if(!record || !customer || customer.signup_id!==record.signup_id)
    return Response.redirect(base+"/setup/?error=expired",302);
  // One-time state: reject any authorization callback replay.
  const consumed=await db.prepare("DELETE FROM onboarding_oauth_states WHERE state_hash=? AND provider='microsoft'").bind(digest).run();
  if(consumed.meta && consumed.meta.changes!==1)
    return Response.redirect(base+"/setup/?error=expired",302);
  let tokens;
  try{
    const response=await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:String(env.MICROSOFT_CLIENT_ID),client_secret:String(env.MICROSOFT_CLIENT_SECRET),
        code,redirect_uri:microsoftRedirect(env),grant_type:"authorization_code",
        code_verifier:record.verifier,scope:"offline_access User.Read Mail.Read"
      })
    });
    if(!response.ok)return Response.redirect(base+"/setup/?error=microsoft_authorization",302);
    tokens=await response.json();
  }catch{return Response.redirect(base+"/setup/?error=microsoft_authorization",302);}
  const granted=String(tokens.scope||"").toLowerCase().split(/\s+/);
  const mailGranted=granted.some(x=>x==="mail.read" || x==="https://graph.microsoft.com/mail.read");
  if(!tokens.access_token || !tokens.refresh_token || !mailGranted)
    return Response.redirect(base+"/setup/?error=microsoft_permission",302);
  // Verify mailbox access without reading or saving any real message.
  let profile;
  try{
    const headers={authorization:"Bearer "+tokens.access_token};
    const identity=await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",{headers});
    if(!identity.ok)return Response.redirect(base+"/setup/?error=microsoft_profile",302);
    profile=await identity.json();
    const mailbox=await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id,displayName",{headers});
    if(!mailbox.ok)return Response.redirect(base+"/setup/?error=microsoft_mailbox",302);
  }catch{return Response.redirect(base+"/setup/?error=microsoft_profile",302);}
  const address=sanitizeText(profile.mail||profile.userPrincipalName,254);
  if(!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    return Response.redirect(base+"/setup/?error=microsoft_profile",302);
  const cipher=await encryptRefresh(tokens.refresh_token,env);
  await db.prepare("UPDATE onboarding_profiles SET microsoft_address=?,microsoft_refresh_encrypted=?,microsoft_connected_at=?,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=? AND status='approved'")
    .bind(address,cipher,nowIso(),record.signup_id).run();
  await audit(db,record.signup_id,"microsoft_mail_read_authorized");
  return Response.redirect(base+"/setup/?connected=microsoft",302);
}
async function microsoftDisconnect(db,row) {
  await db.prepare("UPDATE onboarding_profiles SET microsoft_address=NULL,microsoft_refresh_encrypted=NULL,microsoft_connected_at=NULL,last_test_at=NULL,last_test_engine=NULL,last_test_result=NULL WHERE signup_id=?")
    .bind(row.signup_id).run();
  await audit(db,row.signup_id,"microsoft_connection_removed");
  return respond({ok:true,message:"Outlook/Microsoft 365 disconnected from AirPlain. Its stored authorization was discarded. To withdraw the Microsoft consent itself, also remove AirPlain from your Microsoft account or organizational app permissions."});
}

// Return null for routes not owned here.
export async function handleOnboarding(request,env,path) {
  const method=request.method;
  if(!path.startsWith("/api/admin/") && !path.startsWith("/api/setup/"))return null;
  if(!["GET","POST"].includes(method))return error("Method not allowed.",405);
  if(method==="POST" && !sameOrigin(request))return error("Request must originate from the AirPlain website.",403);
  const db=dbOrError(env);
  if(!db)return error("Customer setup is not connected to the database yet.",503);

  if(path.startsWith("/api/admin/")) {
    if(!authorizedAdmin(request,env))return error("Administrator access required.",401);
    if(method==="GET" && path==="/api/admin/applications")return adminList(db);
    if(method==="POST" && path==="/api/admin/approve")return adminChange(request,db,"approve",env);
    if(method==="POST" && path==="/api/admin/decline")return adminChange(request,db,"decline",env);
    return error("Unknown admin route.",404);
  }
  if(method==="GET" && path==="/api/setup/gmail/callback")return gmailCallback(request,db,env);
  if(method==="GET" && path==="/api/setup/microsoft/callback")return microsoftCallback(request,db,env);
  if(method==="POST" && path==="/api/setup/claim")return claimInvite(request,db);
  const row=await activeCustomer(request,db);
  if(!row)return error("You need an approved, active AirPlain setup invitation.",401);
  if(method==="GET" && path==="/api/setup/status")return respond(publicStatus(row,env));
  if(method==="GET" && path==="/api/setup/gmail/start")return gmailStart(request,db,row,env);
  if(method==="GET" && path==="/api/setup/microsoft/start")return microsoftStart(request,db,row,env);
  if(method==="POST" && path==="/api/setup/preferences")return savePreferences(request,db,row);
  if(method==="POST" && path==="/api/setup/rules")return approveRules(request,db,row);
  if(method==="POST" && path==="/api/setup/test")return runSample(request,db,row,env);
  if(method==="POST" && path==="/api/setup/gmail/disconnect")return gmailDisconnect(db,row,env);
  if(method==="POST" && path==="/api/setup/microsoft/disconnect")return microsoftDisconnect(db,row);
  if(method==="POST" && path==="/api/setup/signout"){
    const digest=await sha(sessionToken(request));
    await db.prepare("DELETE FROM onboarding_sessions WHERE token_hash=?").bind(digest).run();
    return respond({ok:true},200,{"set-cookie":clearCookie()});
  }
  return error("Unknown customer setup route.",404);
}

export { progressFromRow, validateRoutes };
