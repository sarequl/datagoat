import { type FormEvent, useState } from "react";
import type { CreatedInvite, TeamMember } from "../../../../shared/api-types";
import type { Role } from "../../../../shared/permissions";
import { Button, Card, Input, Notice } from "../../components/ui";
import { formatDate, formatRelative } from "./lib/format";
import {
  useAccess,
  useChangeRole,
  useInvite,
  usePendingInvites,
  useRemoveMember,
  useRevokeInvite,
  useSiteId,
  useTeam,
} from "./lib/hooks";
import {
  Badge,
  ConfirmDialog,
  CopyField,
  Field,
  PageHeader,
  QueryState,
  ReadOnlyNotice,
  Select,
} from "./lib/ui";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including the team and deleting the website.",
  member: "View analytics and change settings, goals, funnels, keys and integrations.",
  viewer: "View analytics only.",
};

/** Team: members and roles, invites by link, pending invites (owners manage; others read). */
export default function TeamPage() {
  const siteId = useSiteId();
  const access = useAccess(siteId);
  const team = useTeam(siteId);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Team"
        description="Invite cofounders, marketers or developers. Viewers see analytics; members can also change settings; owners manage the team."
      />
      {!access.canManageTeam ? (
        <ReadOnlyNotice role={access.role} action="manage the team" />
      ) : null}
      {access.canManageTeam ? <InviteCard siteId={siteId} /> : null}
      <Card title="Members">
        {team.data ? (
          <MemberList
            siteId={siteId}
            members={team.data}
            canManage={access.canManageTeam}
            selfId={access.userId}
          />
        ) : (
          <QueryState query={team} />
        )}
      </Card>
      <PendingInvitesCard siteId={siteId} canManage={access.canManageTeam} />
      <Card title="Roles">
        <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr]">
          {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
            <div key={r} className="contents">
              <dt className="font-medium capitalize">{r}</dt>
              <dd className="text-muted">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

function InviteCard({ siteId }: { siteId: string }) {
  const invite = useInvite(siteId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("viewer");
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(
      { email: email.trim(), role },
      {
        onSuccess: (result) => {
          setCreated(result);
          setEmail("");
        },
      },
    );
  };
  return (
    <Card title="Invite someone">
      <form className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end" onSubmit={submit}>
        <Field label="Email">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            autoComplete="off"
          />
        </Field>
        <Field label="Role">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value === "member" ? "member" : "viewer")}
          >
            <option value="viewer">Viewer</option>
            <option value="member">Member</option>
          </Select>
        </Field>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? "Inviting…" : "Create invite"}
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted">{ROLE_HELP[role]}</p>
      {invite.error ? (
        <div className="mt-3">
          <Notice tone="error">{invite.error.message}</Notice>
        </div>
      ) : null}
      {created ? (
        <div className="mt-4 space-y-2 rounded-md border border-line p-3">
          <Notice tone="success">
            Invite created for {created.email} as {created.role}. Send them this link; it works once
            and expires {formatRelative(created.expiresAt)}.
          </Notice>
          <CopyField value={created.inviteUrl} label="Invite link" />
        </div>
      ) : null}
    </Card>
  );
}

function MemberList({
  siteId,
  members,
  canManage,
  selfId,
}: {
  siteId: string;
  members: TeamMember[];
  canManage: boolean;
  selfId: string | null;
}) {
  const changeRole = useChangeRole(siteId);
  const remove = useRemoveMember(siteId);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  return (
    <>
      {roleError ? (
        <div className="mb-3">
          <Notice tone="error">{roleError}</Notice>
        </div>
      ) : null}
      <ul className="divide-y divide-line">
        {members.map((m) => {
          const self = m.userId === selfId;
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium uppercase"
              >
                {(m.name ?? m.email).slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {m.name ?? m.email} {self ? <Badge>You</Badge> : null}
                </div>
                <div className="truncate text-xs text-muted">
                  {m.name ? `${m.email} · ` : ""}joined {formatDate(m.joinedAt)}
                </div>
              </div>
              {canManage && !self ? (
                <>
                  <Select
                    aria-label={`Role of ${m.email}`}
                    className="w-auto"
                    value={m.role}
                    disabled={changeRole.isPending}
                    onChange={(e) => {
                      setRoleError(null);
                      changeRole.mutate(
                        { userId: m.userId, role: e.target.value as Role },
                        { onError: (err) => setRoleError(err.message) },
                      );
                    }}
                  >
                    <option value="owner">Owner</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                  <Button
                    variant="ghost"
                    className="text-error-text"
                    onClick={() => setRemoving(m)}
                    aria-label={`Remove ${m.email}`}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Badge tone={m.role === "owner" ? "primary" : "neutral"}>
                  <span className="capitalize">{m.role}</span>
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.email ?? ""}?`}
        confirmLabel="Remove member"
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => {
          setRemoving(null);
          remove.reset();
        }}
        onConfirm={() =>
          removing && remove.mutate(removing.userId, { onSuccess: () => setRemoving(null) })
        }
      >
        <p>
          They lose access to this website immediately. API keys they created for it stop working.
        </p>
      </ConfirmDialog>
    </>
  );
}

function PendingInvitesCard({ siteId, canManage }: { siteId: string; canManage: boolean }) {
  const invites = usePendingInvites(siteId);
  const revoke = useRevokeInvite(siteId);
  return (
    <Card title="Pending invites">
      {invites.data ? (
        invites.data.length ? (
          <ul className="divide-y divide-line">
            {invites.data.map((inv) => (
              <li key={inv.invitationId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{inv.email}</div>
                  <div className="text-xs text-muted">
                    <span className="capitalize">{inv.role}</span> · sent{" "}
                    {formatDate(inv.createdAt)} · expires {formatRelative(inv.expiresAt)}
                  </div>
                </div>
                {canManage ? (
                  <Button
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(inv.invitationId)}
                    aria-label={`Revoke invite for ${inv.email}`}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No pending invites.</p>
        )
      ) : (
        <QueryState query={invites} />
      )}
      {revoke.error ? (
        <div className="mt-2">
          <Notice tone="error">{revoke.error.message}</Notice>
        </div>
      ) : null}
    </Card>
  );
}
