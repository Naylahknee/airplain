// AirPlain website packaging and booking-flow regression checks.
// These checks do not make network calls or submit pilot requests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const bundle = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const match = bundle.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
assert.ok(match, "Generated page template must exist");
const html = JSON.parse(match[1]);

assert.equal((html.match(/<!DOCTYPE html>/g) || []).length, 1, "Single valid page");
assert.ok(html.includes("--yellow:#ffd60a"), "Preserve brand yellow");
assert.ok(html.includes("--dark:#16171a"), "Preserve dark brand color");
assert.ok(html.includes('font-family: \'Share Tech Mono\''), "Preserve Share Tech Mono");
assert.ok(html.includes('font-family:var(--sans)'), "Preserve existing sans-serif font");
assert.ok(html.includes('aria-label="air/Plain home, AI routes plus AI notes"'), "Accessible brand lockup");
assert.ok(html.includes('<span class="wm-dec">AI routes plus AI notes</span></span></a>'), "Header decoder travels with wordmark");
assert.ok(html.includes('id="nav-toggle"') && html.includes('id="header-nav"'), "Responsive accessible menu");
assert.ok(!html.includes('href="#signup"'), "No landing-page CTA skips fare selection");
assert.ok((html.match(/href="#fares"/g) || []).length >= 3, "General CTAs lead to fares");
assert.ok(html.includes('<section class="sec" id="signup" hidden>'), "Confirmation receipt isn't visible before a request");
assert.deepEqual([...html.matchAll(/data-step="(\d)"/g)].map(x => +x[1]), [1,2,3,4], "Four coherent booking screens");
assert.ok(html.includes('id="st-continue"'), "Optional seat uses one Continue action");
assert.ok(!html.includes('id="st-skip"'), "No competing Skip action");
assert.ok(html.includes('id="bk-submit"'), "Submit inside review dialog");
assert.ok(html.includes('Request my '), "Request action instead of charge promise");
assert.ok(html.includes("Due today: $0."), "Explicit no-payment disclosure");
assert.ok(html.includes('tier:BK.tier,seat:BK.seat'), "Fare and seat preference sent to backend");
assert.ok(html.includes('showTag(Object.assign({},data,{request_id:saved.request_id}))'), "Receipt uses the server-confirmed application reference");
assert.ok(html.includes('id="bp"') && html.indexOf('id="bp"') > html.indexOf('id="tag-wrap"'), "Original cream boarding-pass receipt appears in confirmation");
assert.ok(!html.includes('document.getElementById("bp").style.display="none"'), "Ticket is not hidden when request succeeds");
assert.ok(html.includes('id="bp-name"') && html.includes('id="bp-business"') && html.includes('id="bp-class"'), "Ticket identifies applicant, business and fare");
assert.ok(html.includes('id="stub-seat"') && html.includes('id="stub-ref"'), "Ticket stub shows optional seat preference and actual reference");
assert.ok(html.includes('class="bp-perf"') && html.includes('height:44px'), "Ticket retains perforation and decorative barcode");
assert.ok(html.includes('SEAT REQUEST RECEIVED · NOT A CONFIRMED TICKET'), "Ticket does not falsely claim a confirmed reservation");
assert.ok(!html.includes('id="pilot"'), "No second obsolete application form inside ticket");
assert.ok(html.indexOf('id="bp"') > html.indexOf('<section class="sec" id="signup" hidden>'), "Ticket is only in the initially hidden success section");

assert.ok(html.includes('id="flight-fares"'), "A single flight-selection section replaces old fare accordion");
assert.equal((html.match(/data-book="(?:economy|business|first)"/g) || []).length, 3, "Each fare has exactly one booking button");
assert.ok(!html.includes('class="fx-grid"'), "The old expandable pricing grid is gone");
assert.ok(!html.includes('function pickTier('), "The competing fare-selection state is removed");
assert.ok(html.includes('id="bk-fare-picker"') && html.includes('data-select-fare="first"'), "Fare can be changed inside guided flow");
assert.ok(html.includes('data-change-fare') && html.includes('data-edit="fare"'), "Fare editing remains available");
assert.ok(html.includes('if(interactive&&c!==tier)continue'), "Interactive seat map shows only chosen cabin");
assert.ok(html.includes('aria-label="Request an Economy seat"'), "Every fare has accessible booking CTA");
assert.ok(html.includes('aria-label="Preflight after approval"'), "Application confirmation only previews future onboarding");
assert.ok(!html.includes('id="preflight-list"') && !html.includes('resetPreflight();'), "Application does not offer fake completion checkboxes");
assert.ok(html.includes('Your actual progress will be saved in AirPlain.'), "Approval unlocks separately saved onboarding");
assert.ok(html.indexOf('class="preflight-preview"') > html.indexOf('<section class="sec" id="signup" hidden>'), "Preflight preview stays behind successful submission");
assert.ok(html.includes('No payment was taken and your seat is not yet confirmed.'), "Request success does not promise a purchase");

assert.ok(html.includes('i<n-1?"done":i===n-1?"cur"'), "Progress indicator is indexed correctly");

for (const id of ["b-name","b-business","b-email","b-where"]) {
  assert.ok(html.includes('for="' + id + '"'), "Input " + id + " has a label");
  assert.ok(html.includes('aria-describedby="' + id + '-error"'), "Input " + id + " references its error");
  assert.ok(html.includes('id="' + id + '-error"'), "Error " + id + " exists");
}

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length >= 3, "Expected on-page scripts");
for (const [i,script] of scripts.entries()) new Script(script[1], { filename: "airplain-site-script-" + i + ".js" });
console.log("PASS AirPlain site bundle parses, scripts compile, and booking/header invariants hold");

const admin = readFileSync(new URL("../site/admin/index.html", import.meta.url), "utf8");
const setup = readFileSync(new URL("../site/setup/index.html", import.meta.url), "utf8");
for (const [name,page] of [["admin",admin],["setup",setup]]) {
  assert.ok(page.includes("AirPlain"), name+" page preserves product branding");
  const code = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for(const [i,tag] of code.entries())new Script(tag[1],{filename:name+"-script-"+i+".js"});
}
assert.ok(admin.includes('/api/admin/approve'), "Application admin approves through protected backend");
assert.ok(setup.includes('/api/setup/status') && setup.includes('/api/setup/claim'), "Setup has saved session and invitation claiming");
assert.ok(setup.includes('/api/setup/gmail/start'), "Gmail uses secure provider authorization");
assert.ok(setup.includes('/api/setup/microsoft/start'), "Microsoft 365 has its own secure OAuth route");
assert.ok(setup.includes('id="microsoft-disconnect"'), "Microsoft authorization can be disconnected");
assert.ok(setup.includes('status[provider]'), "Both connected providers render independent verified statuses");
