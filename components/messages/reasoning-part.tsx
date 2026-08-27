import { ReasoningUIPart } from "ai";
import { Reasoning } from "../ai-elements/reasoning";
import { ReasoningTrigger } from "../ai-elements/reasoning";
import { ReasoningContent } from "../ai-elements/reasoning";
import type { FunLabelCategory } from "@/lib/fun-labels";
import { REASONING_DISPLAY_MODE, REASONING_TRUNCATE_WORDS } from "@/config";

function truncateText(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(" ") + "...";
}

export function ReasoningPart({ part, isStreaming = false, category = "thinking", duration, onDurationChange }: { part: ReasoningUIPart; isStreaming?: boolean; category?: FunLabelCategory; duration?: number; onDurationChange?: (duration: number) => void }) {
    const mode = REASONING_DISPLAY_MODE;

    // "hidden" mode: show trigger only (past-tense label), no expandable content
    if (mode === "hidden") {
        return <Reasoning isStreaming={isStreaming} duration={duration} onReasoningDurationChange={onDurationChange} className="mb-0" defaultOpen={false}>
            <ReasoningTrigger category={category} />
        </Reasoning>;
    }

    // Determine display text
    let displayText = part.text || "";
    if (mode === "truncated" && displayText) {
        displayText = truncateText(displayText, REASONING_TRUNCATE_WORDS);
    }

    return <Reasoning isStreaming={isStreaming} duration={duration} onReasoningDurationChange={onDurationChange} className="mb-0">
        <ReasoningTrigger category={category} />
        {displayText && <ReasoningContent>
            {displayText}
        </ReasoningContent>}
    </Reasoning>;
}
