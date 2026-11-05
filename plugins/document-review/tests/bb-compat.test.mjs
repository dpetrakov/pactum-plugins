import assert from "node:assert/strict";
import test from "node:test";
import { openFixedTab, openThreadTab, registerNavPanel, registerThreadPanel } from "../ui/bb-compat.ts";

const component = () => null;
const nav = { id: "docs", title: "Documents", path: "docs", icon: "FileText", component };
const tab = { panelId: "docs", id: "comments", title: "Comments", icon: "MessageSquare", component };

test("bb 0.46 receives only its original nav and thread panel registrations", () => {
  const collected = [];
  const app = { slots: {
    navPanel: (value) => collected.push(["nav", value]),
    threadPanelAction: (value) => collected.push(["thread", value]),
  } };
  registerNavPanel(app, { ...nav, fixedTabs: [tab] });
  const threadTab = { id: "docs", title: "Documents", icon: "FileText", component };
  registerThreadPanel(app, threadTab);
  assert.deepEqual(collected, [["nav", { ...nav, fixedTabs: [tab] }], ["thread", threadTab]]);
});

test("current bb registers identical tab IDs in explicit contexts without retired keys", () => {
  const collected = [];
  const app = { slots: {
    navPanel: (value) => collected.push(["nav", value]),
    experimental_tab: (value) => collected.push(["tab", value]),
    threadPanelAction: () => assert.fail("the new host must not use the retired registration"),
  } };
  registerNavPanel(app, { ...nav, fixedTabs: [tab] });
  registerThreadPanel(app, { id: "docs", title: "Documents", icon: "FileText", component });
  assert.deepEqual(collected[0], ["nav", nav]);
  assert.deepEqual(collected[1], ["tab", { id: "comments", title: "Comments", icon: "MessageSquare", component,
    context: { kind: "nav-panel", panelId: "docs" }, availability: "fixed" }]);
  assert.deepEqual(collected[2][1], { id: "docs", title: "Documents", icon: "FileText", component,
    context: { kind: "thread" }, availability: "action" });
});

test("a fixed tab retains its target on the current surface in both API generations", () => {
  const target = { sessionId: "session-one" };
  const options = { surface: { kind: "current" }, tab, target };
  const old = { openFixedTab(value) { assert.equal(value, options); return true; } };
  assert.equal(openFixedTab(old, options), true);
  const current = { openTab(value) {
    assert.deepEqual(value, { tab: { id: "comments", context: { kind: "nav-panel", panelId: "docs" }, availability: "fixed" }, target });
    return true;
  } };
  assert.equal(openFixedTab(current, options), true);
});

test("thread tabs preserve instance params and title without navigating to another surface", () => {
  const options = { actionId: "docs", title: "Guide", params: { subPath: "guide.md" } };
  const navigate = { openThreadPanel(value) { assert.equal(value, options); return true; } };
  assert.equal(openThreadTab({}, navigate, options), true);
  assert.equal(openThreadTab({ openTab(value) {
    assert.deepEqual(value, { tab: { id: "docs", context: { kind: "thread" }, availability: "action" }, title: "Guide", params: options.params });
    return true;
  } }, { openThreadPanel: () => assert.fail("do not invoke both generations") }, options), true);
});

test("a host refusal stays false and does not fall through into a second open", () => {
  const old = { openFixedTab: () => false };
  assert.equal(openFixedTab(old, { surface: { kind: "current" }, tab }), false);
  const current = { openTab: () => false, openFixedTab: () => assert.fail("refusal is not missing capability") };
  assert.equal(openFixedTab(current, { surface: { kind: "current" }, tab }), false);
  assert.equal(openThreadTab(current, { openThreadPanel: () => assert.fail("refusal is not missing capability") }, { actionId: "docs" }), false);
});

test("unavailable panel capabilities decline without an exception", () => {
  assert.equal(openFixedTab({}, { surface: { kind: "current" }, tab }), false);
  assert.equal(openThreadTab({}, {}, { actionId: "docs" }), false);
  assert.throws(() => registerThreadPanel({ slots: {} }, { id: "docs" }), /does not support/);
});
