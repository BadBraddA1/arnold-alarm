/**
 * Play a configured ACTIONS entry on campus speakers (used by phone IVR).
 */
import { triggerAction, type ActionMap } from "./protect.js";
import { stopTalkback } from "./talkback.js";

function loadActions(): ActionMap {
  try {
    return JSON.parse(process.env.ACTIONS || "{}") as ActionMap;
  } catch {
    return {};
  }
}

export async function playLocalAction(actionId: string): Promise<void> {
  const actions = loadActions();
  if (actionId === "__all_clear__") {
    stopTalkback();
    const def = actions["evacuate.code_green"];
    if (!def) throw new Error("All clear action not configured");
    await triggerAction(def, { actionId: "evacuate.code_green" });
    return;
  }
  const def = actions[actionId];
  if (!def) throw new Error(`Unknown action: ${actionId}`);
  const loop =
    actionId === "evacuate.code_red" ||
    actionId === "evacuate.code_blue" ||
    actionId === "evacuate.main";
  await triggerAction(def, { actionId, loop });
}
