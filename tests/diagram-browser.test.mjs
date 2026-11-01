import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../plugins/document-review/node_modules/playwright/index.mjs";
const site = fileURLToPath(new URL("../site", import.meta.url));
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml" };
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const view = page => page.locator("#diagram-canvas svg").getAttribute("viewBox").then(s => s.split(" ").map(Number));
test("approved logo, coherent comparison and controlled pointer motion across all viewport edges", { timeout: 60000 }, async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const relative = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = path.resolve(site, `.${relative === "/" ? "/index.html" : relative}`);
      if (!file.startsWith(`${site}${path.sep}`)) throw Error("outside site");
      res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream"); res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end("Not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch(), errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.evaluate(() => document.fonts.ready);
    const logo = await page.locator(".site-header .wordmark").evaluate(e => ({ font: getComputedStyle(e).fontFamily, style: getComputedStyle(e).fontStyle, shape: getComputedStyle(e.querySelector(".seal")).borderRadius, background: getComputedStyle(e.querySelector(".seal")).backgroundColor, dotTop: getComputedStyle(e.querySelector(".seal"), ":after").top }));
    assert.match(logo.font, /Fraunces/); assert.equal(logo.style, "normal"); assert.equal(logo.shape, "4px"); assert.equal(logo.dotTop, "-4px"); assert.notEqual(logo.background, "rgba(0, 0, 0, 0)");
    await page.locator("#diagram-scroll").scrollIntoViewIfNeeded(); await page.waitForSelector("#diagram-canvas svg");
    assert.equal(await page.locator(".dr-dg__ghost-edge").count(), 0);
    assert.match(await page.locator("#diagram-change-list").textContent(), /− Agent edit → Published/);
    const node = page.locator('[data-node="draft"]');
    for (const direction of ["right", "left", "bottom", "top"]) {
      await page.locator("#reset-diagram").click(); await page.locator("#diagram-scroll").scrollIntoViewIfNeeded();
      const start = center(await node.boundingBox()), port = await page.locator("#diagram-scroll").boundingBox();
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      const grabbed = center(await node.boundingBox());
      assert.ok(Math.hypot(grabbed.x - start.x, grabbed.y - start.y) < 2, "taking the node must not move it");
      const dx = direction === "left" ? -20 : 20, dy = direction === "top" ? -10 : 10;
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
      const moved = center(await node.boundingBox());
      assert.ok(Math.abs(moved.x - start.x - dx) < 2 && Math.abs(moved.y - start.y - dy) < 2, "visible motion must be 1:1");
      const before = await view(page);
      const outside = { x: direction === "right" ? port.x + port.width + 80 : direction === "left" ? port.x - 80 : moved.x,
        y: direction === "bottom" ? Math.min(1000, port.y + port.height) + 70 : direction === "top" ? port.y - 70 : moved.y };
      await page.mouse.move(outside.x, outside.y); await page.waitForTimeout(250);
      const delayed = await view(page);
      assert.ok(Math.abs(delayed[0] - before[0]) < 1 && Math.abs(delayed[1] - before[1]) < 1, "no pan before dwell");
      assert.equal(delayed[2], before[2]); assert.equal(delayed[3], before[3]);
      await page.waitForTimeout(1150); const panned = await view(page);
      const distance = Math.hypot(panned[0] - before[0], panned[1] - before[1]);
      assert.ok(distance > 3 && distance < 30, `slow, bounded ${direction} pan: ${distance}`);
      assert.equal(panned[2], before[2]); assert.equal(panned[3], before[3]);
      const held = center(await node.boundingBox()); await page.mouse.up();
      const dropped = center(await node.boundingBox()); assert.ok(Math.hypot(held.x - dropped.x, held.y - dropped.y) < 4, "drop preserves the screen anchor");
      const stopped = await view(page); await page.waitForTimeout(150); assert.deepEqual(await view(page), stopped, "no inertia after drop");
      // A second gesture starts from the view left by the first one.
      await page.mouse.move(dropped.x, dropped.y); await page.mouse.down(); await page.mouse.move(dropped.x - dx, dropped.y - dy, { steps: 5 });
      await page.keyboard.press("Escape"); await page.mouse.up();
      const cancelled = center(await node.boundingBox()); assert.ok(Math.hypot(cancelled.x - dropped.x, cancelled.y - dropped.y) < 4, "Escape restores the previous position and view");
    }
    const mobile = await browser.newPage({ viewport: { width: 390, height: 1000 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    mobile.on("pageerror", error => errors.push(error.message));
    await mobile.goto(`http://127.0.0.1:${server.address().port}`); await mobile.evaluate(() => document.fonts.ready);
    await mobile.locator("#diagram-scroll").scrollIntoViewIfNeeded();
    const touchNode = mobile.locator('[data-node="draft"]'); await touchNode.scrollIntoViewIfNeeded();
    const touchStart = center(await touchNode.boundingBox()), port = await mobile.locator("#diagram-scroll").boundingBox();
    await mobile.evaluate(() => {
      window.touchDefaults = [];
      document.querySelector("#diagram-canvas svg").addEventListener("touchstart", event => window.touchDefaults.push(event.defaultPrevented));
    });
    const cdp = await mobile.context().newCDPSession(mobile);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...touchStart, id: 1 }] });
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchStart.x + i * 4, y: touchStart.y + i * 2, id: 1 }] });
      await mobile.waitForTimeout(20);
    }
    const touchMoved = center(await touchNode.boundingBox());
    assert.ok(Math.abs(touchMoved.x - touchStart.x - 20) < 2 && Math.abs(touchMoved.y - touchStart.y - 10) < 2, "touch stays in the gesture instead of native scrolling");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.min(388, port.x + port.width + 8), y: touchStart.y + 10, id: 1 }] });
    const first = await view(mobile); await mobile.waitForTimeout(1350); const last = await view(mobile);
    assert.ok(last[0] - first[0] > 3 && last[0] - first[0] < 30, "touch uses the same slow pan policy");
    assert.equal(first[2], last[2]); assert.equal(first[3], last[3]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    const cancelled = center(await touchNode.boundingBox()); assert.ok(Math.hypot(cancelled.x - touchStart.x, cancelled.y - touchStart.y) < 3);
    const svgBox = await mobile.locator("#diagram-canvas svg").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: svgBox.x + 4, y: svgBox.y + 60, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await mobile.evaluate(() => window.touchDefaults), [true, false], "only handles consume native touch scrolling");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
