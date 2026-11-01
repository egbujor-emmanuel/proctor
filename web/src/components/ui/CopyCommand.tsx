import { CopyButton } from "./CopyButton";

type Props = {
  command: string;
  label: string;
};

/** A shell command with a copy button. The command stays selectable text. */
export function CopyCommand({ command, label }: Props) {
  return (
    <div className="relative rounded-md border border-rule bg-paper-sunk">
      <pre className="hash whitespace-pre-wrap px-4 py-3 pr-20 text-[13px] leading-relaxed text-ink">
        <code>{command}</code>
      </pre>
      <CopyButton text={command} label={label} className="absolute right-2 top-2" />
    </div>
  );
}
