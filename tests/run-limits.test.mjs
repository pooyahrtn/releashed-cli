import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetExhausted,
  checkActionAuthorized,
  detectWall,
  forbiddenAction,
  inScope,
  typedValueAllowed,
  FORBIDDEN_VERBS,
  OWNER_FORBIDDEN_VERBS,
} from "../lib/run-limits.mjs";

const ORIGINS = new Set(["https://example.com"]);

test("scope is the origin allow-list, then the path globs", () => {
  assert.equal(inScope("https://example.com/anything", ORIGINS), true, "no globs means origin only");
  assert.equal(inScope("https://elsewhere.com/", ORIGINS), false);
  assert.equal(inScope("chrome-error://chromewebdata/", ORIGINS), false, "a failed navigation is not in scope");
  assert.equal(inScope("about:blank", ORIGINS), false);

  const scope = { include: ["/tools/**", "/app/**"], exclude: ["/tools/legacy/**"] };
  assert.equal(inScope("https://example.com/tools/a/b", ORIGINS, scope), true);
  assert.equal(inScope("https://example.com/app/x", ORIGINS, scope), true);
  assert.equal(inScope("https://example.com/blog/post", ORIGINS, scope), false, "outside every include glob");
  assert.equal(inScope("https://example.com/tools/legacy/x", ORIGINS, scope), false, "exclude beats include");
  assert.equal(inScope("https://example.com/blog/x", ORIGINS, { exclude: ["/blog/**"] }), false);
  assert.equal(inScope("https://example.com/pricing", ORIGINS, { exclude: ["/blog/**"] }), true, "exclude alone lets the rest through");
});

test("named verbs are never performed, and word boundaries keep it from over-reaching", () => {
  assert.equal(forbiddenAction({ instruction: "Click the Send button", target: "the Send button" }), "send");
  assert.equal(forbiddenAction({ instruction: "Delete this dashboard", target: "the bin icon" }), "delete");
  assert.equal(forbiddenAction({ instruction: "Pay now", target: "the pay now button" }), "pay");
  assert.equal(forbiddenAction({ instruction: "Post the comment", target: "Post" }), "post");
  assert.equal(forbiddenAction({ instruction: "Type the password", target: "the password box" }), null, "password is not pay");
  assert.equal(forbiddenAction({ instruction: "Fill in the postcode", target: "postcode field" }), null, "postcode is not post");
  assert.equal(forbiddenAction({ instruction: "Click Send", target: "" }, []), null, "an empty list forbids nothing");
});

test("a typed value must be one the user seeded, or something that is not contact-shaped", () => {
  assert.equal(typedValueAllowed("amsterdam"), true, "an ordinary search term is free");
  assert.equal(typedValueAllowed("mapper@example.com"), false, "an invented address is not");
  assert.equal(typedValueAllowed("mapper@example.com", ["mapper@example.com"]), true, "the user's own value is");
  assert.equal(typedValueAllowed("other@example.com", ["mapper@example.com"]), false);
  assert.equal(typedValueAllowed("hunter2 password"), false);
});

test("the pre-dispatch gate enforces scope, verbs and seeds together", () => {
  const at = "https://example.com/tools/a";
  const tap = { action: "tap", instruction: "Open the report", target: "the report card" };
  assert.equal(checkActionAuthorized(tap, ORIGINS, at, true).authorized, true);
  assert.equal(
    checkActionAuthorized(tap, ORIGINS, at, true, { pathScope: { include: ["/app/**"] } }).authorized,
    false,
    "a page outside the include globs takes no more input",
  );
  const send = { action: "tap", instruction: "Click Send to submit the form", target: "the Send button" };
  const refused = checkActionAuthorized(send, ORIGINS, at, true);
  assert.equal(refused.authorized, false);
  assert.match(refused.reason, /never performs "send"/);
  assert.equal(checkActionAuthorized(send, ORIGINS, at, false).authorized, true, "a product we own keeps today's behavior");

  const type = { action: "type", instruction: "Type the address", target: "the email box", text: "person@example.com" };
  assert.equal(checkActionAuthorized(type, ORIGINS, at, true).authorized, false, "invented");
  assert.equal(
    checkActionAuthorized(type, ORIGINS, at, true, { seedValues: ["person@example.com"] }).authorized,
    true,
    "seeded by the user",
  );
});

test("a wall is a finding: a bot check always, a login wall only at the front door", () => {
  const bot = detectWall("https://example.com/", "e1 [text] Please complete the CAPTCHA to continue");
  assert.equal(bot.kind, "bot-wall");
  assert.match(bot.reason, /does not try to get around one/);
  assert.equal(detectWall("https://example.com/", "e1 [text] unusual traffic from your network").kind, "bot-wall");

  const login = "e1 [button] Sign in\ne2 [textbox] Email";
  assert.equal(detectWall("https://example.com/login", login), null, "mid-run, a sign-in page is just a screen");
  assert.equal(detectWall("https://example.com/login", login, { entry: true }).kind, "login-wall");
  assert.equal(detectWall("https://example.com/", login, { entry: true }), null, "a home page with a sign-in link is not a wall");
  assert.equal(detectWall("https://example.com/dashboards", "e1 [link] Dashboards"), null);
});

test("minutes and euros are hard aborts, and unset means unbounded", () => {
  assert.equal(budgetExhausted({ elapsedSeconds: 100_000, minutes: null, costEur: 99, maxEur: null }), null);
  assert.equal(budgetExhausted({ elapsedSeconds: 1_800, minutes: 30, costEur: 0, maxEur: 5 }).reason, "time_budget_exhausted");
  assert.equal(budgetExhausted({ elapsedSeconds: 60, minutes: 30, costEur: 0.5, maxEur: 0.5 }).reason, "cost_budget_exhausted");
  assert.equal(budgetExhausted({ elapsedSeconds: 60, minutes: 30, costEur: null, maxEur: 0.5 }), null, "an unpriced model is not over budget");
  assert.match(budgetExhausted({ elapsedSeconds: 60, minutes: 1, costEur: 0, maxEur: null }).detail, /1-minute budget/);
});

// Two real dogfood refusals: a verb quoted inside the PRODUCT's own words is not the action a
// control performs, in either mode. (This replaces an earlier version of this test that asserted
// the old substring match refused the "Split & Send" tap in stranger mode -- that was the bug.)
test("a verb quoted in the product's own words does not refuse the step, in either mode", () => {
  const at = "https://example.com/lessons";
  const tap = { action: "tap", instruction: "Tap the 'Split & Send' lesson item", target: "the Split & Send lesson item" };
  const stranger = checkActionAuthorized(tap, ORIGINS, at, true);
  assert.equal(stranger.authorized, true, "the lesson's own name is not the run sending anything");

  const owner = checkActionAuthorized(tap, ORIGINS, at, true, { forbidden: OWNER_FORBIDDEN_VERBS, mine: true });
  assert.equal(owner.authorized, true, "owner mode allows ordinary product verbs like send/post/submit");

  const quiz = { action: "tap", instruction: "Select an answer option", target: "the 'You pay it yourself' option" };
  assert.equal(checkActionAuthorized(quiz, ORIGINS, at, true).authorized, true, "a quiz answer's own text is not the run paying");
  assert.equal(
    checkActionAuthorized(quiz, ORIGINS, at, true, { forbidden: OWNER_FORBIDDEN_VERBS, mine: true }).authorized,
    true,
  );
});

test("a verb that IS the control's action still refuses, in the mode it applies to", () => {
  const at = "https://example.com/lessons";
  const send = { action: "tap", instruction: "Tap the Send button", target: "Send" };
  assert.equal(checkActionAuthorized(send, ORIGINS, at, true).authorized, false, "a real Send button");

  const sendMessage = { action: "tap", instruction: "Tap the Send message button", target: "Send message" };
  assert.equal(checkActionAuthorized(sendMessage, ORIGINS, at, true).authorized, false, "a real Send message button");

  const ownerLimits = { forbidden: OWNER_FORBIDDEN_VERBS, mine: true };
  const payNow = { action: "tap", instruction: "Tap Pay now", target: "Pay now" };
  assert.equal(checkActionAuthorized(payNow, ORIGINS, at, true, ownerLimits).authorized, false);

  const yesDelete = { action: "tap", instruction: "Confirm the deletion", target: "Yes, delete" };
  assert.equal(checkActionAuthorized(yesDelete, ORIGINS, at, true, ownerLimits).authorized, false);

  const deleteAccount = { action: "tap", instruction: "Tap Delete account", target: "Delete account" };
  assert.equal(checkActionAuthorized(deleteAccount, ORIGINS, at, true, ownerLimits).authorized, false);

  const checkout = { action: "tap", instruction: "Go to the checkout page to finish buying", target: "the cart icon" };
  assert.equal(checkActionAuthorized(checkout, ORIGINS, at, true, ownerLimits).authorized, false, "checkout destination, owner mode");
});

test("owner mode still refuses pay and delete instructions, and a billing-looking destination however it is worded", () => {
  const at = "https://example.com/account";
  const limits = { forbidden: OWNER_FORBIDDEN_VERBS, mine: true };

  const pay = { action: "tap", instruction: "Pay the invoice now", target: "the pay now button" };
  assert.equal(checkActionAuthorized(pay, ORIGINS, at, true, limits).authorized, false);

  const del = { action: "tap", instruction: "Delete this dashboard", target: "the bin icon" };
  assert.equal(checkActionAuthorized(del, ORIGINS, at, true, limits).authorized, false);

  const billing = { action: "tap", instruction: "Open the billing settings", target: "billing" };
  const refusedBilling = checkActionAuthorized(billing, ORIGINS, at, true, limits);
  assert.equal(refusedBilling.authorized, false);
  assert.match(refusedBilling.reason, /billing/);

  const checkout = { action: "tap", instruction: "Go to checkout", target: "the checkout link" };
  assert.equal(checkActionAuthorized(checkout, ORIGINS, at, true, limits).authorized, false);

  // Ordinary product verbs stay allowed in owner mode -- that is the whole point.
  const submit = { action: "tap", instruction: "Submit the answer", target: "the submit button" };
  assert.equal(checkActionAuthorized(submit, ORIGINS, at, true, limits).authorized, true);
});

test("OWNER_FORBIDDEN_VERBS is money-and-destruction only, exported next to FORBIDDEN_VERBS", () => {
  assert.deepEqual(OWNER_FORBIDDEN_VERBS, ["pay", "delete"]);
  assert.deepEqual(FORBIDDEN_VERBS, ["send", "post", "pay", "delete"]);
});
