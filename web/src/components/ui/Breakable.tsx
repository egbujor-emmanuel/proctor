import { Fragment } from "react";

/**
 * An id or URL that may wrap after "/", "." and ":" before it wraps anywhere
 * else, so "agent:attrito.testnet/demo-agent" never splits as "testne/t".
 */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/.:])/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}
