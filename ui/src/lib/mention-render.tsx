import type { ReactNode } from "react";
import { MentionChip } from "@/components/projects/MentionPicker";

type MentionEntry = {
  entityType: "agent" | "user" | "artifact";
  entityId: string;
  label: string;
  artifactType?: string;
};

/** Render content with @-mention chips inline.
 *
 * Artifact mentions render as clickable chips that navigate to the artifact
 * editor (`/company/:cid/artifacts?artifactId=<entityId>`). Agent and user
 * mentions render as non-clickable chips.
 */
export function renderMentionContent(
  content: string,
  mentions: MentionEntry[] | undefined,
  companyId: string,
): ReactNode {
  if (!mentions || mentions.length === 0) return content;

  const labels = mentions.map((m) =>
    m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const regex = new RegExp(`(@(?:${labels.join("|")}))`, "g");
  const parts = content.split(regex);

  return parts.map((part, i) => {
    const mention = mentions.find((m) => `@${m.label}` === part);
    if (mention) {
      return (
        <MentionChip
          key={i}
          entityType={mention.entityType}
          label={mention.label}
          companyId={
            mention.entityType === "artifact" ? companyId : undefined
          }
          entityId={
            mention.entityType === "artifact" ? mention.entityId : undefined
          }
        />
      );
    }
    return <span key={i}>{part}</span>;
  });
}
