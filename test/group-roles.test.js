import test from "node:test";
import assert from "node:assert/strict";
import { getVerifiedGroupInfo, isGroupAdmin } from "../src/group-roles.js";

test("creator and deputy admins are exempt; ordinary members are not", async () => {
  const group = { creatorId: "100", adminIds: ["200"] };
  const api = { getGroupInfo: async (id) => ({ gridInfoMap: { [id]: group } }) };
  const info = await getVerifiedGroupInfo(api, "group-1");
  assert.equal(isGroupAdmin(info, "100"), true);
  assert.equal(isGroupAdmin(info, 200), true);
  assert.equal(isGroupAdmin(info, "300"), false);
});

test("unverified group roles cannot be treated as an ordinary sender", async () => {
  for (const info of [undefined, { creatorId: "100" }, { adminIds: [] }]) {
    await assert.rejects(getVerifiedGroupInfo({
      getGroupInfo: async () => ({ gridInfoMap: { "group-1": info } }),
    }, "group-1"), /Không xác minh được/);
  }
});
