import { useEffect, useState } from 'react';
import { api } from './api';
import { downloadArtifact } from './ResultsPanel';

interface Notice { id: string; message: string; readAt: string | null; scheduledDeletionAt: string | null }
interface Retention { retentionDays: number; noticeDays: number | null; deletionMode: string; automaticDeletionEnabled: boolean }
export function ProjectDataPanel({ projectId }: { projectId: string }) {
  const [policy, setPolicy] = useState<Retention | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [deletion, setDeletion] = useState<{ id: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api<Retention>(`/projects/${projectId}/retention`), api<{ items: Notice[] }>(`/projects/${projectId}/notifications`)])
      .then(([p, n]) => { if (active) { setPolicy(p); setNotices(n.items); } })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Project data unavailable'); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (!deletion || deletion.status === 'completed') return;
    let active = true;
    const timer = setInterval(() => {
      void api<{ id: string; status: string }>(`/deletion-requests/${deletion.id}`).then((value) => { if (active) setDeletion(value); })
        .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Deletion status unavailable'); });
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [deletion?.id, deletion?.status]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="project-data"><h2 id="project-data">Project data and notices</h2>
    {policy && <p>Retention target: {policy.retentionDays} days. Automatic deletion: {policy.automaticDeletionEnabled ? 'enabled' : 'disabled'}.
      {policy.noticeDays && ` Notice lead time: ${policy.noticeDays} days.`}</p>}
    {notices.length === 0 && <p>No notices.</p>}
    {notices.map((notice) => <div key={notice.id}><p>{notice.message}</p>
      {!notice.readAt && <button disabled={busy || !!deletion} onClick={() => void action(async () => {
        const updated = await api<{ readAt: string }>(`/notifications/${notice.id}/read`, {});
        setNotices((items) => items.map((item) => item.id === notice.id ? { ...item, readAt: updated.readAt } : item));
      })}>Mark notice read</button>}</div>)}
    <button disabled={busy || !!deletion} onClick={() => void action(async () => {
      const exported = await api<{ artifactId: string }>(`/projects/${projectId}/exports`, {});
      await downloadArtifact(exported.artifactId);
    })}>Export project data</button>
    <p>Export contains plan versions, run summaries, and the stored artifact files. Download a copy before requesting deletion.</p>
    <label className="check"><input type="checkbox" checked={confirmed} disabled={!!deletion} onChange={(event) => setConfirmed(event.target.checked)} />
      I have saved any data I need and confirm deletion of this project.</label>
    <button disabled={busy || !confirmed || !!deletion} onClick={() => void action(async () => {
      setDeletion(await api<{ id: string; status: string }>(`/projects/${projectId}/deletion-requests`, { confirmed: true }));
    })}>Request project deletion</button>
    {deletion && <p>Deletion request {deletion.id}: {deletion.status}. Project access is disabled while deletion is processed.</p>}
    <p role="status">{message}</p>
  </section>;
}
