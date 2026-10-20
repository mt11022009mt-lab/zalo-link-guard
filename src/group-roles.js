export function isGroupAdmin(group, userId) {
  return String(group.creatorId) === String(userId) ||
    group.adminIds.some((id) => String(id) === String(userId));
}

export async function getVerifiedGroupInfo(api, groupId) {
  const result = await api.getGroupInfo(String(groupId));
  const group = result?.gridInfoMap?.[String(groupId)];
  if (!group?.creatorId || !Array.isArray(group.adminIds)) {
    throw new Error("Không xác minh được quản trị viên của nhóm trên Zalo.");
  }
  return group;
}
