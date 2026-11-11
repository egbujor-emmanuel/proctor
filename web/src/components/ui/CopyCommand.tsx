import { CopyButton } from "./CopyButton";

type Props = {
  command: string;
  label: string;
};

/**
 * A shell command with a copy button. The button sits in a bar above the command, never on
 * top of it, so a long line that scrolls sideways is never hidden. The command stays selectable.
 */
export function CopyCommand({ command, label }: Props) {
  return (
    <div className="relative min-w-0 rounded-md border border-rule bg-paper-sunk">
      <div className="flex items-center justify-end gap-2 border-b border-rule px-2 py-1.5">
        <CopyButton text={command} label={label} />
      </div>
      <pre className="hash overflow-x-auto whitespace-pre px-4 py-3 text-[13px] leading-relaxed text-ink">
        <code>{command}</code>
      </pre>
    </div>
  );
}
