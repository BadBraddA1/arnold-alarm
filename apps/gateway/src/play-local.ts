/**
 * Play a configured ACTIONS entry on campus speakers (used by phone IVR).
 */
import {
  triggerAction,
  withActionVolume,
  type ActionMap,
} from "./protect.js";
import { stopTalkback, stopTalkbackAndWait } from "./talkback.js";

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
    await withActionVolume("evacuate.code_green", async () => {
      await stopTalkbackAndWait();
      const def = actions["evacuate.code_green"];
      if (!def) throw new Error("All clear action not configured");
      await triggerAction(def, { actionId: "evacuate.code_green" });
    });
    return;
  }
  if (actionId.startsWith("test.speaker:")) {
    const speakerId = actionId.slice("test.speaker:".length).trim();
    if (!/^[a-f0-9]{16,32}$/i.test(speakerId)) {
      throw new Error("Invalid speaker id");
    }
    const file =
      (process.env.TEST_ONE_FILE || "Test_Start_Tone.mp3").trim() ||
      "Test_Start_Tone.mp3";
    const { startTalkback } = await import("./talkback.js");
    await withActionVolume(actionId, () =>
      startTalkback({
        actionId,
        file,
        speakerIds: [speakerId],
        awaitDone: true,
      }),
    );
    return;
  }
  const def = actions[actionId];
  if (!def) throw new Error(`Unknown action: ${actionId}`);
  const loop =
    actionId === "evacuate.code_red" ||
    actionId === "evacuate.code_blue" ||
    actionId === "evacuate.main";
  if (actionId === "test.speakers") {
    try {
      const { notifyDeskPhonesOfTest } = await import("./pa-sip.js");
      await notifyDeskPhonesOfTest();
    } catch (err) {
      console.warn(
        "[play-local] desk phone notify failed — continuing",
        err instanceof Error ? err.message : err,
      );
    }
  }
  await withActionVolume(actionId, () =>
    triggerAction(def, { actionId, loop }),
  );
}
