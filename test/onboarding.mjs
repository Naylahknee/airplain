// Integration tests for owner approval and approved-only preflight.
// In-memory D1 adapter matches only the SQL used by the paths under test.
import assert from "node:assert/strict";
import { webcrypto as nodeCrypto } from "node:crypto";
import { handleOnboarding, progressFromRow, validateRoutes } from "../src/onboarding.js";

if (!globalThis.crypto) globalThis.crypto=nodeCrypto;
const secret="test-key-"+("x".repeat(38));
const app={id:"signup_test",name:"Jordan Lee",business:"Lee Plumbing",email:"jordan@example.com",fare:"economy",
  preferred_seat:"6D",where_piled_up:"Email",created_at:"2026-10-14T20:00:00Z"};
class MockD1 {
  constructor(){this.profiles=new Map();this.invites=new Map();this.sessions=new Map();this.oauthStates=new Map();this.events=[];}
  prepare(sql){
    const self=this;
    return {bind(...args){
      const q=sql;
      return {
        async first(){
          if(q.includes("FROM pilot_signups WHERE id=?"))return args[0]===app.id?app:null;
          if(q.includes("FROM onboarding_oauth_states o JOIN onboarding_profiles")){
            const pvd=q.includes("o.provider='microsoft'")?"microsoft":"gmail";
            for(const st of self.oauthStates.values()){
              const profile=self.profiles.get(st.signup_id);
              if(st.state_hash===args[0] && st.provider===pvd && st.expires_at>args[1] && profile?.status==="approved")return {...st};
            }
            return null;
          }
          if(q.includes("FROM onboarding_profiles WHERE signup_id=?"))return self.profiles.get(args[0])||null;
          if(q.includes("FROM onboarding_invites i JOIN onboarding_profiles")) {
            for(const i of self.invites.values()){
              const p=self.profiles.get(i.signup_id);
              if(i.token_hash===args[0] && !i.used_at && i.expires_at>args[1] && p?.status==="approved")return {...i};
            }return null;
          }
          if(q.includes("FROM onboarding_sessions s JOIN onboarding_profiles")){
            for(const s of self.sessions.values()){
              const p=self.profiles.get(s.signup_id);
              if(s.token_hash===args[0] && s.expires_at>args[1] && p?.status==="approved")return {...p,...app,signup_id:app.id};
            }return null;
          }
          throw new Error("Unexpected first SQL: "+q);
        },
        async all(){
          if(q.includes("LEFT JOIN onboarding_profiles")){
            const p=self.profiles.get(app.id);
            return {results:[{...app,status:p?.status||"pending",approved_at:p?.approved_at||null}]};
          }
          throw new Error("Unexpected all SQL: "+q);
        },
        async run(){
          if(q.startsWith("INSERT INTO onboarding_profiles")){
            const p=self.profiles.get(args[0])||{signup_id:args[0],status:"pending"};
            if(q.includes("'approved'")){p.status="approved";p.approved_at=args[1];p.declined_at=null;}
            else if(q.includes("'declined'")){p.status="declined";p.declined_at=args[1];p.approved_at=null;
              p.gmail_address=null;p.gmail_refresh_encrypted=null;p.gmail_connected_at=null;
              p.microsoft_address=null;p.microsoft_refresh_encrypted=null;p.microsoft_connected_at=null;}
            self.profiles.set(args[0],p);return {meta:{changes:1}};
          }
          if(q.startsWith("DELETE FROM onboarding_invites")){
            for(const [id,i] of self.invites)if(i.signup_id===args[0])self.invites.delete(id);
            return {meta:{changes:1}};
          }
          if(q.startsWith("DELETE FROM onboarding_sessions")){
            for(const [id,i] of self.sessions)if((q.includes("WHERE token_hash=")?i.token_hash===args[0]:i.signup_id===args[0]))self.sessions.delete(id);
            return {meta:{changes:1}};
          }
          if(q.startsWith("DELETE FROM onboarding_oauth_states")){
            let deleted=0;
            for(const [id,v] of self.oauthStates){
              const match=q.includes("WHERE signup_id=")?v.signup_id===args[0]:v.state_hash===args[0];
              if(match){self.oauthStates.delete(id);deleted++;}
            }
            return {meta:{changes:deleted}};
          }
          if(q.startsWith("INSERT INTO onboarding_oauth_states")){
            self.oauthStates.set(args[0],{state_hash:args[0],signup_id:args[1],provider:args[2],
              verifier:args[3],expires_at:args[4],created_at:args[5]});
            return {meta:{changes:1}};
          }
          if(q.startsWith("INSERT INTO onboarding_invites")){
            self.invites.set(args[0],{id:args[0],signup_id:args[1],token_hash:args[2],expires_at:args[3],used_at:null,created_at:args[4]});
            return {meta:{changes:1}};
          }
          if(q.startsWith("INSERT INTO onboarding_sessions")){
            self.sessions.set(args[0],{id:args[0],signup_id:args[1],token_hash:args[2],expires_at:args[3],created_at:args[4]});
            return {meta:{changes:1}};
          }
          if(q.startsWith("INSERT INTO onboarding_events")){self.events.push({id:args[0],signup_id:args[1],action:args[2]});return {meta:{changes:1}};}
          if(q.startsWith("UPDATE onboarding_invites SET used_at=")){
            const row=self.invites.get(args[1]);
            if(!row||row.used_at)return {meta:{changes:0}};
            row.used_at=args[0];return {meta:{changes:1}};
          }
          if(q.startsWith("UPDATE onboarding_profiles SET microsoft_address=?")){
            Object.assign(self.profiles.get(args[3]),{microsoft_address:args[0],
              microsoft_refresh_encrypted:args[1],microsoft_connected_at:args[2],
              last_test_at:null,last_test_engine:null,last_test_result:null});
            return {meta:{changes:1}};
          }
          if(q.startsWith("UPDATE onboarding_profiles SET microsoft_address=NULL")){
            Object.assign(self.profiles.get(args[0]),{microsoft_address:null,microsoft_refresh_encrypted:null,
              microsoft_connected_at:null,last_test_at:null,last_test_engine:null,last_test_result:null});
            return {meta:{changes:1}};
          }
          if(q.startsWith("UPDATE onboarding_profiles SET routes_json")){
            Object.assign(self.profiles.get(args[2]),{routes_json:args[0],preferences_saved_at:args[1],
              rules_approved_at:null,last_test_at:null,last_test_engine:null,last_test_result:null});return {meta:{changes:1}};
          }
          if(q.startsWith("UPDATE onboarding_profiles SET last_test_engine")){
            Object.assign(self.profiles.get(args[3]),{last_test_engine:args[0],last_test_result:args[1],last_test_at:args[2]});return {meta:{changes:1}};
          }
          if(q.startsWith("UPDATE onboarding_profiles SET rules_text")){
            Object.assign(self.profiles.get(args[2]),{rules_text:args[0],rules_approved_at:args[1],last_test_at:null,last_test_engine:null,last_test_result:null});return {meta:{changes:1}};
          }
          throw new Error("Unexpected run SQL: "+q);
        }
      };
    },async all(){return this.bind().all();}};
  }
}
const db=new MockD1();
const env={AIRPLAIN_DB:db,AIRPLAIN_ADMIN_KEY:secret};
const base="https://airplain.example";
async function call(path,method="GET",body,headers={},environment=env){
  const req=new Request(base+path,{method,headers:{...(body!==undefined?{"content-type":"application/json"}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const res=await handleOnboarding(req,environment,new URL(req.url).pathname);
  const data=await res.json();
  return {status:res.status,data,cookie:res.headers.get("set-cookie")};
}
const validRoutes={billing:"flag_owner",appointments:"book_time",sales:"answer_now",general:"flag_owner"};
assert.equal(validateRoutes(validRoutes).appointments,"book_time");
assert.equal(validateRoutes({...validRoutes,billing:"reply_without_review"}),null);
assert.deepEqual(progressFromRow({}),{connected:false,routes:false,approved:false,tested:false,completed:0});
assert.equal(progressFromRow({gmail_address:"a@b.com",gmail_connected_at:"now",preferences_saved_at:"now",
  rules_approved_at:"now",last_test_at:"now",last_test_engine:"stub"}).completed,3,"Stub fallback is not marked real AI");
assert.equal(progressFromRow({microsoft_address:"outlook@contoso.com",microsoft_connected_at:"now",preferences_saved_at:"now",
  rules_approved_at:"now",last_test_at:"now",last_test_engine:"workers-ai"}).completed,4,
  "Outlook alone qualifies as the connected first inbox");
assert.equal((await call("/api/admin/applications")).status,401,"admin access closed by default");
assert.equal((await call("/api/admin/applications","GET",undefined,{authorization:"Bearer invalid"})).status,401,"bad key rejected");
const auth={authorization:"Bearer "+secret};
const list=await call("/api/admin/applications","GET",undefined,auth);
assert.equal(list.status,200);
assert.equal(list.data.applications[0].status,"pending");
const approval=await call("/api/admin/approve","POST",{application_id:app.id},auth);
assert.equal(approval.status,200);
assert.equal(approval.data.status,"approved");
assert.ok(approval.data.invitation_url.includes("/setup/#invite="));
assert.equal((await call("/api/admin/approve","POST",{application_id:"not_found"},auth)).status,404);
assert.equal((await call("/api/setup/status")).status,401,"unapproved visitors have no setup access");
assert.equal((await call("/api/setup/status","GET",undefined,{cookie:"ap_setup_session=not_valid"})).status,401,
  "A pending or unauthenticated visitor cannot retrieve a boarding pass");
const token=approval.data.invitation_url.split("#invite=")[1];
assert.ok(token.length>=40,"invitation is strong");
assert.equal((await call("/api/setup/claim","POST",{token:"bad"})).status,400);
const claim=await call("/api/setup/claim","POST",{token});
assert.equal(claim.status,200);
assert.ok(claim.cookie.includes("HttpOnly")&&claim.cookie.includes("Secure")&&claim.cookie.includes("SameSite=Lax"));
assert.equal((await call("/api/setup/claim","POST",{token})).status,401,"invite is one use");
const cookies={cookie:claim.cookie.split(";")[0]};
const customer=await call("/api/setup/status","GET",undefined,cookies);
assert.equal(customer.status,200);
assert.equal(customer.data.customer.business,"Lee Plumbing");
assert.equal(customer.data.customer.application_reference,app.id,"Approved customer sees the saved application reference");
assert.ok(customer.data.customer.approved_at,"Boarding pass carries the real administrator approval date");
assert.equal(customer.data.progress.completed,0);
assert.equal(customer.data.microsoft.connected,false);
assert.equal(customer.data.microsoft.available,false);
assert.equal((await call("/api/setup/rules","POST",{approve:true},cookies)).status,409,"rules need preferences first");
assert.equal((await call("/api/setup/preferences","POST",{routes:{...validRoutes,billing:"send_reply"}},cookies)).status,400);
const saved=await call("/api/setup/preferences","POST",{routes:validRoutes,special_instructions:"Never send automated messages"},cookies);
assert.equal(saved.status,200);
assert.equal((await call("/api/setup/status","GET",undefined,cookies)).data.progress.completed,1);
assert.equal((await call("/api/setup/rules","POST",{approve:false},cookies)).status,400);
const rules=await call("/api/setup/rules","POST",{approve:true,instructions:"Flag refunds"},cookies);
assert.equal(rules.status,200);
assert.equal((await call("/api/setup/status","GET",undefined,cookies)).data.progress.completed,2);
assert.equal((await call("/api/setup/test","POST",{message:"Please reschedule this appointment"},cookies)).status,409,
  "Cannot fake an AI test before connecting either inbox");
assert.equal((await call("/api/setup/gmail/start","GET",undefined,cookies)).status,503,"Gmail cannot pretend to connect without OAuth keys");
assert.equal((await call("/api/setup/microsoft/start","GET",undefined,cookies)).status,503,"Microsoft cannot pretend to connect without OAuth keys");
// Simulate an existing verified provider connection to test the honest stub fallback.
Object.assign(db.profiles.get(app.id),{gmail_address:"jordan@example.com",gmail_connected_at:new Date().toISOString()});
const demo=await call("/api/setup/test","POST",{message:"Please reschedule this appointment on Friday"},cookies);
assert.equal(demo.status,200);
assert.equal(demo.data.real_ai,false);
assert.equal(demo.data.result.engine,"stub");
assert.equal((await call("/api/setup/status","GET",undefined,cookies)).data.progress.completed,3,
 "A demonstration using the stub must never show 4 of 4");
assert.ok(!JSON.stringify(db.profiles.get(app.id)).includes("Please reschedule this appointment"),"Raw customer sample text is not saved");

// Microsoft read-only OAuth integration: fake Graph responses without outbound network.
const oauthEnv={...env,MICROSOFT_CLIENT_ID:"test-client",MICROSOFT_CLIENT_SECRET:"test-secret",
  OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64"),PUBLIC_BASE_URL:base};
const authorizedLink=await handleOnboarding(new Request(base+"/api/setup/microsoft/start",{headers:cookies}),oauthEnv,"/api/setup/microsoft/start");
assert.equal(authorizedLink.status,302);
const authorize=new URL(authorizedLink.headers.get("location"));
assert.equal(authorize.host,"login.microsoftonline.com");
assert.equal(authorize.searchParams.get("scope"),"offline_access User.Read Mail.Read");
assert.equal(authorize.searchParams.get("code_challenge_method"),"S256");
assert.ok(authorize.searchParams.get("code_challenge").length>20);
const oauthState=authorize.searchParams.get("state");
assert.equal(db.oauthStates.size,1);
assert.equal([...db.oauthStates.values()][0].provider,"microsoft");
const withoutSession=await handleOnboarding(new Request(base+"/api/setup/microsoft/callback?code=fake-code&state="+oauthState),
  oauthEnv,"/api/setup/microsoft/callback");
assert.equal(withoutSession.status,302,"OAuth callback must have the approved customer's session");
assert.ok(withoutSession.headers.get("location").includes("error=expired"));
assert.equal(db.oauthStates.size,1,"Rejected session must not consume valid OAuth state");
const previousFetch=globalThis.fetch;
const outbound=[];
globalThis.fetch=async (url,options={})=>{
  outbound.push(String(url));
  if(String(url).includes("login.microsoftonline.com") && String(url).endsWith("/token")){
    assert.equal(options.body.get("client_secret"),"test-secret");
    assert.ok(options.body.get("code_verifier").length>=40);
    return new Response(JSON.stringify({access_token:"MOCK_MS_ACCESS",refresh_token:"SUPER_SECRET_REFRESH_TOKEN",
      scope:"User.Read Mail.Read offline_access"}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(String(url).includes("graph.microsoft.com/v1.0/me?")){
    return new Response(JSON.stringify({mail:"outlook@contoso.com",userPrincipalName:"outlook@contoso.com"}),{status:200});
  }
  if(String(url).includes("graph.microsoft.com/v1.0/me/mailFolders/inbox?")){
    return new Response(JSON.stringify({id:"inbox-id",displayName:"Inbox"}),{status:200});
  }
  throw new Error("Unexpected outbound service "+url);
};
try{
  const cb=await handleOnboarding(new Request(base+"/api/setup/microsoft/callback?code=fake-code&state="+oauthState,
    {headers:cookies}),oauthEnv,"/api/setup/microsoft/callback");
  assert.equal(cb.status,302);
  assert.ok(cb.headers.get("location").includes("connected=microsoft"));
}finally{globalThis.fetch=previousFetch;}
assert.deepEqual(outbound.map(x=>new URL(x).host),[
  "login.microsoftonline.com","graph.microsoft.com","graph.microsoft.com"
]);
assert.equal(db.oauthStates.size,0,"OAuth state consumed once");
assert.equal(db.profiles.get(app.id).microsoft_address,"outlook@contoso.com");
assert.ok(db.profiles.get(app.id).microsoft_refresh_encrypted.includes("."));
assert.ok(!db.profiles.get(app.id).microsoft_refresh_encrypted.includes("SUPER_SECRET_REFRESH_TOKEN"),
  "Microsoft refresh token must be encrypted at rest");
assert.equal((await call("/api/setup/status","GET",undefined,cookies,oauthEnv)).data.microsoft.connected,true);
assert.equal((await call("/api/setup/status","GET",undefined,cookies,oauthEnv)).data.progress.completed,3);
const disconnected=await call("/api/setup/microsoft/disconnect","POST",{},cookies,oauthEnv);
assert.equal(disconnected.status,200);
assert.equal(db.profiles.get(app.id).microsoft_refresh_encrypted,null,"Disconnect purges encrypted token");
assert.equal((await call("/api/setup/status","GET",undefined,cookies,oauthEnv)).data.progress.completed,3,
  "Disconnecting Microsoft must not remove first-inbox credit while Gmail remains connected");
Object.assign(db.profiles.get(app.id),{gmail_address:null,gmail_connected_at:null});
assert.equal((await call("/api/setup/status","GET",undefined,cookies,oauthEnv)).data.progress.completed,2,
  "Disconnecting the only remaining inbox must remove first-inbox credit");
Object.assign(db.profiles.get(app.id),{gmail_address:"jordan@example.com",gmail_connected_at:new Date().toISOString()});
assert.equal((await call("/api/setup/status","GET",undefined,cookies,oauthEnv)).data.progress.completed,3,
  "Either provider alone restores first-inbox completion");

const badOrigin=await call("/api/setup/preferences","POST",{routes:validRoutes},{...cookies,origin:"https://attacker.example"});
assert.equal(badOrigin.status,403,"cross-origin changes denied");
const decline=await call("/api/admin/decline","POST",{application_id:app.id},auth);
assert.equal(decline.status,200);
assert.equal((await call("/api/setup/status","GET",undefined,cookies)).status,401,"decline revokes existing sessions");
assert.equal((await call("/api/admin/applications","GET",undefined,auth)).data.applications[0].status,"declined");
console.log("PASS Approved-only customer onboarding, secure invite, saved routing, rules and no fake AI completion");
