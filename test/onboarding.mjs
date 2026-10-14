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
  constructor(){this.profiles=new Map();this.invites=new Map();this.sessions=new Map();this.events=[];}
  prepare(sql){
    const self=this;
    return {bind(...args){
      const q=sql;
      return {
        async first(){
          if(q.includes("FROM pilot_signups WHERE id=?"))return args[0]===app.id?app:null;
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
            else if(q.includes("'declined'")){p.status="declined";p.declined_at=args[1];p.approved_at=null;}
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
          if(q.startsWith("DELETE FROM onboarding_oauth_states"))return {meta:{changes:1}};
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
          if(q.startsWith("UPDATE onboarding_profiles SET routes_json")){
            Object.assign(self.profiles.get(args[2]),{routes_json:args[0],preferences_saved_at:args[1],
              rules_approved_at:null,last_test_at:null,last_test_engine:null,last_test_result:null});return {meta:{changes:1}};
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
assert.equal(customer.data.progress.completed,0);
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
  "Cannot fake an AI test before authorizing Gmail");
const badOrigin=await call("/api/setup/preferences","POST",{routes:validRoutes},{...cookies,origin:"https://attacker.example"});
assert.equal(badOrigin.status,403,"cross-origin changes denied");
const decline=await call("/api/admin/decline","POST",{application_id:app.id},auth);
assert.equal(decline.status,200);
assert.equal((await call("/api/setup/status","GET",undefined,cookies)).status,401,"decline revokes existing sessions");
assert.equal((await call("/api/admin/applications","GET",undefined,auth)).data.applications[0].status,"declined");
console.log("PASS Approved-only customer onboarding, secure invite, saved routing, rules and no fake AI completion");
