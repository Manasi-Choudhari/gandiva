"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TxLink } from "@/components/tx-link";
import { usdc, stars } from "@/lib/format";
import {
  isAgentResult,
  type AgentResult,
  type Quote,
  type Run,
  type RunResult,
} from "@/lib/types";

export function ResultView({ run }: { run: Run }) {
  const result = run.result;
  if (!result) return null;
  return isAgentResult(result) ? (
    <AgentResultView result={result} />
  ) : (
    <BooksResultView result={result} />
  );
}

const label = (key: string) => key.replace(/_/g, " ");

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>—</span>;
  // A transaction hash (for example from an agent that paid other sellers) links to the block explorer.
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return <TxLink hash={value} />;
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="break-all text-primary underline-offset-4 hover:underline"
      >
        {value}
      </a>
    );
  }
  if (typeof value === "object") {
    return (
      <span className="break-words font-mono text-[11px]">
        {JSON.stringify(value)}
      </span>
    );
  }
  return <span className="break-words">{String(value)}</span>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Key/value rows for one record; nested lists of records are shown as compact JSON. */
function RecordCard({ value, title }: { value: Record<string, unknown>; title?: string }) {
  const entries = Object.entries(value);
  const heading = title ?? (typeof value.title === "string" ? value.title : undefined);
  return (
    <Card size="sm">
      {heading ? (
        <CardHeader>
          <CardTitle>{heading}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className="flex flex-col gap-1.5 text-xs">
        {entries
          .filter(([k]) => !(heading && k === "title" && title === undefined))
          .map(([k, v]) => (
            <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
              <span className="text-muted-foreground">{label(k)}</span>
              <Scalar value={v} />
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function OutputValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length && value.every(isRecord)) {
      return (
        <div className="grid gap-4 md:grid-cols-2">
          {value.map((item, i) => (
            <RecordCard key={i} value={item} />
          ))}
        </div>
      );
    }
    return (
      <ul className="list-disc pl-5 text-sm">
        {value.map((item, i) => (
          <li key={i}>
            <Scalar value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) return <RecordCard value={value} />;
  return (
    <p className="text-sm">
      <Scalar value={value} />
    </p>
  );
}

/** The model sometimes answers in markdown; show **bold** as bold instead of literal asterisks. */
function Inline({ text }: { text: string }) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}

function AgentResultView({ result }: { result: AgentResult }) {
  const outputs = Object.entries(result.outputs ?? {});
  return (
    <div className="flex flex-col gap-5">
      <p className="whitespace-pre-wrap rounded-xl border border-border bg-card/40 p-4 text-sm leading-relaxed">
        <Inline text={result.answer} />
      </p>
      {outputs.map(([key, value]) => (
        <section key={key} className="flex flex-col gap-2">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {label(key)}
          </h3>
          <OutputValue value={value} />
        </section>
      ))}
    </div>
  );
}

export function QuoteView({ quote, budget }: { quote: Quote; budget: string }) {
  const over = BigInt(quote.total) > BigInt(budget);
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Turn</TableHead>
              <TableHead>Result name</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Estimate (USDC)</TableHead>
              <TableHead>Purpose</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quote.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono">{l.turn}</TableCell>
                <TableCell className="font-mono">{l.as}</TableCell>
                <TableCell className="font-mono">
                  {l.service}
                  {l.skipped ? " (over budget)" : ""}
                </TableCell>
                <TableCell>{l.category}</TableCell>
                <TableCell className="text-right font-mono">
                  {usdc(l.estimate)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {l.purpose ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm">
        Estimated total:{" "}
        <span className="font-mono">{usdc(quote.total)} USDC</span> of a{" "}
        <span className="font-mono">{usdc(budget)} USDC</span> budget
        {over ? " — more budget is needed." : "."}
      </p>
      <p className="text-xs text-muted-foreground">{quote.note}</p>
    </div>
  );
}

function BooksResultView({ result }: { result: RunResult }) {
  const priceKey = `price_${result.currency.toLowerCase()}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
        <span>
          pages scraped:{" "}
          <span className="text-foreground">
            {result.pagesScraped.join(", ") || "none"}
          </span>
        </span>
        <span>
          missing:{" "}
          <span className="text-foreground">
            {result.pagesMissing.join(", ") || "none"}
          </span>
        </span>
        <span>
          fx {result.currency}:{" "}
          <span className="text-foreground">
            {result.fxRate ?? "n/a"} {result.fxDate ? `(${result.fxDate})` : ""}
          </span>
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {result.books.map((b, i) => (
          <Card key={i} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span>{b.title}</span>
                <span className="font-mono text-xs text-warn">
                  {stars(b.rating)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              <div className="font-mono">
                £{b.price_gbp} →{" "}
                <span className="text-primary">
                  {String(b[priceKey] ?? "?")} {result.currency}
                </span>
              </div>
              <div className="text-muted-foreground">
                {b.summary_hi ?? "(no summary)"}
              </div>
              <a
                href={b.url}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-[11px] text-primary underline-offset-4 hover:underline"
              >
                {b.url}
              </a>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function Explanation({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-card/40 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
      {text}
    </pre>
  );
}
