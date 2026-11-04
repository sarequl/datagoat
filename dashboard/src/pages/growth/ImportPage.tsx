import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ImportJob } from "../../../../shared/api-types";
// The same Web-API-only parser the Worker uses: exports are parsed here, in the browser, and
// uploaded in chunks, which keeps the Worker within the Free plan's CPU limits.
import { type ImportRow, parsePlausibleZip } from "../../../../src/growth/imports/plausible";
import { api, apiGet } from "../../api/client";
import { Button, Card, Notice, Spinner } from "../../components/ui";
import { fmtDate, fmtNumber, PageHeader, Table, useSiteId } from "./shared";

export const CHUNK = 1000;

const STATUS_LABEL: Record<ImportJob["status"], string> = {
  pending: "Waiting",
  processing: "Importing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Removed",
};

/** Upload parsed rows in chunks; reports progress after each chunk. */
export async function uploadRows(
  siteId: string,
  jobId: string,
  rows: readonly ImportRow[],
  onProgress: (done: number) => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await api.post(`/api/v1/admin/websites/${siteId}/imports/${jobId}/rows`, {
      rows: rows.slice(i, i + CHUNK),
    });
    onProgress(Math.min(rows.length, i + CHUNK));
  }
  await api.post(`/api/v1/admin/websites/${siteId}/imports/${jobId}/complete`);
}

/** Import historical analytics from a Plausible CSV export (.zip). */
export default function ImportPage() {
  const siteId = useSiteId();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const jobs = useQuery({
    queryKey: ["imports", siteId],
    queryFn: () => apiGet<ImportJob[]>(`/api/v1/admin/websites/${siteId}/imports`),
  });
  const run = useMutation({
    mutationFn: async (f: File) => {
      const parsed = await parsePlausibleZip(new Uint8Array(await f.arrayBuffer()));
      const job = (
        await api.post<ImportJob[]>(`/api/v1/admin/websites/${siteId}/imports`, {
          source: "plausible",
          fileName: f.name,
        })
      ).data[0];
      if (!job) throw new Error("Could not create the import");
      setProgress({ done: 0, total: parsed.rows.length });
      await uploadRows(siteId, job.id, parsed.rows, (done) =>
        setProgress({ done, total: parsed.rows.length }),
      );
      return parsed;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["imports", siteId] }),
  });
  const remove = useMutation({
    mutationFn: (job: ImportJob) =>
      api.delete(`/api/v1/admin/websites/${siteId}/imports/${job.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["imports", siteId] }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import"
        description="Bring your history from Plausible: pageviews, visitors, sources, pages, countries, devices and UTM campaigns. Goals need to be set up again."
      />
      <Card title="Import a Plausible export">
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            In Plausible, open the site settings → Imports &amp; Exports → Export data (not the
            chart export).
          </li>
          <li>Download the .zip from the email Plausible sends you.</li>
          <li>Choose it below and start the import. The file is read in your browser.</li>
        </ol>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) run.mutate(file);
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Plausible export (.zip)</span>
            <input
              type="file"
              accept=".zip,application/zip"
              aria-label="Plausible export (.zip)"
              className="block text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Button type="submit" disabled={!file || run.isPending}>
            {run.isPending ? "Importing…" : "Start import"}
          </Button>
        </form>
        {progress && run.isPending ? (
          <div className="mt-3" role="status">
            <div className="h-2 overflow-hidden rounded bg-surface-2">
              <div
                className="h-full bg-primary"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted">
              {fmtNumber(progress.done)} of {fmtNumber(progress.total)} rows
            </p>
          </div>
        ) : null}
        {run.error ? <Notice tone="error">{run.error.message}</Notice> : null}
        {run.isSuccess ? (
          <Notice tone="success">
            Imported {fmtNumber(run.data.rows.length)} rows ({run.data.rangeStart} to{" "}
            {run.data.rangeEnd}). Imported days show in your analytics until your DataGoat tracking
            starts.
          </Notice>
        ) : null}
      </Card>
      <Card title="Imports">
        {jobs.isPending ? (
          <Spinner />
        ) : (
          <Table
            caption="Imports"
            rows={jobs.data ?? []}
            rowKey={(j) => j.id}
            empty="No imports yet."
            columns={[
              { key: "file", header: "File", render: (j) => j.fileName ?? "Plausible export" },
              {
                key: "range",
                header: "Dates",
                render: (j) => (j.rangeStart ? `${j.rangeStart} – ${j.rangeEnd}` : "–"),
              },
              {
                key: "rows",
                header: "Rows",
                align: "right",
                render: (j) => fmtNumber(j.rowsImported),
              },
              {
                key: "status",
                header: "Status",
                render: (j) => (
                  <span
                    className={
                      j.status === "failed"
                        ? "text-error-text"
                        : j.status === "completed"
                          ? "text-success-text"
                          : ""
                    }
                  >
                    {STATUS_LABEL[j.status]}
                    {j.error ? `: ${j.error}` : ""}
                  </span>
                ),
              },
              { key: "when", header: "Created", render: (j) => fmtDate(j.createdAt) },
              {
                key: "actions",
                header: "",
                render: (j) =>
                  j.status === "cancelled" ? null : (
                    <Button
                      variant="ghost"
                      aria-label={`Remove import ${j.fileName ?? j.id}`}
                      onClick={() => {
                        if (window.confirm("Remove this import and its imported data?"))
                          remove.mutate(j);
                      }}
                    >
                      Remove
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
