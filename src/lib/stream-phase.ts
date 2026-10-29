/** Shared phase model for every streamed AI card (annotation replies, wiki drafts). */
export type StreamPhase = 'reading' | 'thinking' | 'replying';

export const STREAM_PHASE_LABEL: Record<StreamPhase, string> = {
  reading: '读取中',
  thinking: '思考中',
  replying: '撰写中'
};

export function streamPhaseOf(stream: { reasoning: string; text: string } | null | undefined): StreamPhase {
  return stream?.text ? 'replying' : stream?.reasoning ? 'thinking' : 'reading';
}
