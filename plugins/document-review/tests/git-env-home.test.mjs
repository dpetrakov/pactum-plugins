// A host daemon run by systemd without HOME (ssh5, 2026-10-10): git could not read ~/.gitconfig, so a global
// user.email set by the user stayed invisible and writes were refused with C3. gitEnv() restores HOME.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCheckout, gitEnv } from "../node/checkout.ts";

test("gitEnv fills HOME from the account database when the daemon has none", () => {
  const saved = process.env.HOME;
  delete process.env.HOME;
  try {
    assert.equal(gitEnv().HOME, os.userInfo().homedir);
  } finally {
    process.env.HOME = saved;
  }
});

test("gitEnv keeps an explicit HOME", () => {
  const saved = process.env.HOME;
  process.env.HOME = "/tmp/some-home";
  try {
    assert.equal(gitEnv().HOME, "/tmp/some-home");
  } finally {
    process.env.HOME = saved;
  }
});

test("a global user.email is seen even when the daemon starts without HOME", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "drv-home-"));
  const repo = path.join(fixture, "repo");
  const home = path.join(fixture, "account-home");
  const expected = "reader@pactum-tests.invalid";
  const saved = process.env.HOME;
  const userInfo = os.userInfo;
  try {
    await fs.mkdir(repo);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, ".gitconfig"), `[user]\n  email = ${expected}\n`);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    // Model a service account with its own global configuration, without touching the real account's files.
    os.userInfo = (...args) => ({ ...userInfo(...args), homedir: home });
    delete process.env.HOME;
    const info = await resolveCheckout(repo);
    assert.equal(info.identity.email, expected);
  } finally {
    os.userInfo = userInfo;
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
