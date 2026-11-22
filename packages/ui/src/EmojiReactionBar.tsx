export const CURATED_STUDENT_EMOJIS = [
  { id: "thumbs_up", glyph: "👍", label: "Got it" },
  { id: "lightbulb", glyph: "💡", label: "Aha moment" },
  { id: "thinking", glyph: "🤔", label: "Need review" },
  { id: "fire", glyph: "🔥", label: "Great tactic" },
  { id: "handshake", glyph: "🤝", label: "Good game" },
  { id: "star", glyph: "⭐", label: "Favorite" },
] as const;

export type CuratedStudentEmojiId = (typeof CURATED_STUDENT_EMOJIS)[number]["id"];

export interface EmojiReactionBarProps {
  selected?: CuratedStudentEmojiId | null;
  onSelect?: (emojiId: CuratedStudentEmojiId) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Curated, fixed emoji palette for student responses on Kibitz and Hall.
 * By design, contains zero free-text inputs to enforce student interaction safety.
 */
export function EmojiReactionBar({
  selected = null,
  onSelect,
  disabled = false,
  label = "Student reaction",
}: EmojiReactionBarProps) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="emoji-reaction-bar"
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: "0.5rem",
        alignItems: "center",
      }}
    >
      {CURATED_STUDENT_EMOJIS.map((item) => {
        const isActive = selected === item.id;
        return (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            aria-pressed={isActive}
            aria-label={item.label}
            title={item.label}
            onClick={() => onSelect?.(item.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.35rem 0.65rem",
              borderRadius: "9999px",
              border: isActive ? "2px solid #2563eb" : "1px solid #cbd5e1",
              backgroundColor: isActive ? "#dbeafe" : "#ffffff",
              color: "#0f172a",
              cursor: disabled ? "not-allowed" : "pointer",
              fontSize: "0.95rem",
            }}
          >
            <span aria-hidden="true">{item.glyph}</span>
            <span style={{ fontSize: "0.8rem" }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
