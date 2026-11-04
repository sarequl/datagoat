import { useState } from "react";
import type { AttributionModel, Website, WebsiteUpdate } from "../../../../shared/api-types";
import { Card } from "../../components/ui";
import { changedFields, useAccess, useSiteId, useUpdateWebsite, useWebsite } from "./lib/hooks";
import {
  Field,
  QueryState,
  RadioCards,
  ReadOnlyNotice,
  SaveRow,
  Select,
  SettingsLayout,
  Toggle,
} from "./lib/ui";

/** Website settings > Attribution & revenue: attribution model and revenue reporting options. */
export default function AttributionSettingsPage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  const disabled = !access.canEditSettings;
  return (
    <SettingsLayout siteId={siteId} domain={website.data?.domain}>
      {website.data ? (
        <div className="space-y-5">
          {disabled ? <ReadOnlyNotice role={access.role} action="change settings" /> : null}
          <ModelCard website={website.data} disabled={disabled} />
          <RevenueCard website={website.data} disabled={disabled} />
        </div>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}

const MODELS = [
  {
    value: "first_touch",
    label: "First touch (default)",
    description:
      "Credit the channel of the visitor's first visit. Shows what brings new people to you; DataFast uses this model.",
  },
  {
    value: "last_touch",
    label: "Last touch",
    description: "Credit the channel of the visit where the payment happened.",
  },
  {
    value: "last_non_direct",
    label: "Last non-direct touch",
    description:
      "Credit the last visit that came from a real source, ignoring direct visits such as typing your URL or a bookmark.",
  },
] as const satisfies ReadonlyArray<{ value: AttributionModel; label: string; description: string }>;

function ModelCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const [model, setModel] = useState<AttributionModel>(website.attributionModel);
  return (
    <Card title="Attribution model">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ attributionModel: model });
        }}
      >
        <p className="text-sm text-muted">
          Decides which visit gets the credit when a visitor pays. Revenue in the channel, referrer,
          campaign, page and location cards follows this model. Changing it re-reads existing
          payments; nothing is lost.
        </p>
        <RadioCards
          legend="Attribution model"
          name="attribution-model"
          options={MODELS}
          value={model}
          onChange={setModel}
          disabled={disabled}
        />
        <SaveRow
          dirty={model !== website.attributionModel}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}

type RevenueDraft = {
  includeRenewalRevenue: boolean;
  revenueMetric: "revenue" | "mrr";
  storeCustomerEmails: boolean;
};

function RevenueCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const original: RevenueDraft = {
    includeRenewalRevenue: website.includeRenewalRevenue,
    revenueMetric: website.revenueMetric === "mrr" ? "mrr" : "revenue",
    storeCustomerEmails: website.storeCustomerEmails,
  };
  const [draft, setDraft] = useState(original);
  const changes = changedFields(original, draft);
  return (
    <Card title="Revenue">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(changes as WebsiteUpdate, {
            onSuccess: (w) =>
              setDraft({
                includeRenewalRevenue: w.includeRenewalRevenue,
                revenueMetric: w.revenueMetric === "mrr" ? "mrr" : "revenue",
                storeCustomerEmails: w.storeCustomerEmails,
              }),
          });
        }}
      >
        <Toggle
          label="Include renewal revenue"
          description="Count subscription renewals in revenue, revenue per visitor and conversion KPIs. Turn off to measure only new revenue."
          checked={draft.includeRenewalRevenue}
          disabled={disabled}
          onChange={(v) => setDraft({ ...draft, includeRenewalRevenue: v })}
        />
        <Field label="Headline revenue metric" hint="What the revenue KPI shows on the overview.">
          <Select
            value={draft.revenueMetric}
            disabled={disabled}
            onChange={(e) =>
              setDraft({ ...draft, revenueMetric: e.target.value === "mrr" ? "mrr" : "revenue" })
            }
          >
            <option value="revenue">Revenue in the period</option>
            <option value="mrr">Monthly recurring revenue (MRR)</option>
          </Select>
        </Field>
        <Toggle
          label="Store customer names and emails"
          description="Keeps names and emails from payments so you can see who paid. Off stores only a hash for matching; API keys without the PII flag never see them either way."
          checked={draft.storeCustomerEmails}
          disabled={disabled}
          onChange={(v) => setDraft({ ...draft, storeCustomerEmails: v })}
        />
        <SaveRow
          dirty={Object.keys(changes).length > 0}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}
