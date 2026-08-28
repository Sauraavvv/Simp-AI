"use client";

import { useEffect, useRef } from "react";
import type { CallPhase } from "@/lib/useVoiceCall";

/**
 * How long the last free turn is given to start speaking before the call is
 * ended anyway. Only reached when speech never begins at all; a browser that is
 * going to speak starts well inside this, and the wait is invisible because the
 * limit card is already on screen.
 */
export const SPEECH_GRACE_MS = 2500;

/**
 * End a call once its final allowed turn has been *heard*.
 *
 * This lives on its own because getting it wrong is silent and it has been
 * wrong twice. The obvious readings both fail:
 *
 *  - Ending when the limit is reached cuts the answer off before it is written.
 *    useChat.send appends the user's message before the reply streams, so the
 *    count hits the limit while the reply to it is still being composed, and
 *    call.end stops speech.
 *
 *  - Ending on phase "listening" cuts it off before it is spoken. The phase is
 *    derived as `speaking ? "speaking" : isLoading ? "thinking" : "listening"`,
 *    and with server TTS absent speech only starts once the whole reply is in
 *    -- so there is a render where the stream has closed and speech has not yet
 *    begun. It reads "listening", and ending there cancelled the very answer
 *    the wait was for: the text reached the transcript and was never spoken.
 *
 * So the signal is speech itself. `spoken` is armed when this turn starts
 * talking and read when it stops, which is the only moment the answer is
 * genuinely finished. If speech never starts -- unavailable, or blocked until
 * the visitor interacts -- the grace timer ends the call anyway rather than
 * leaving the mic open forever.
 */
export function useHangupWhenSpoken({
  phase,
  active,
  reached,
  end,
}: {
  phase: CallPhase;
  active: boolean;
  /** The allowance is used up, so this turn is the last one. */
  reached: boolean;
  end: () => void;
}): void {
  const spoken = useRef(false);

  useEffect(() => {
    if (phase === "thinking") spoken.current = false; // a new turn began
    else if (phase === "speaking") spoken.current = true;
  }, [phase]);

  useEffect(() => {
    if (!reached || !active || phase !== "listening") return;
    if (spoken.current) {
      end();
      return;
    }
    const timer = setTimeout(end, SPEECH_GRACE_MS);
    return () => clearTimeout(timer);
  }, [reached, active, phase, end]);
}
