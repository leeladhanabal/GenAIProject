import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Plan, type PlanVersion } from './api';
import { RunPanel } from './RunPanel';
import { ProjectDataPanel } from './ProjectDataPanel';
import './style.css';

function App() {
  const [projectId, setProjectId] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [versionNumber, setVersionNumber] = useState(1);
  const [name, setName] = useState('');
  const [requirements, setRequirements] = useState('');
  const [specification, setSpecification] = useState('');
  const [definition, setDefinition] = useState('');
  const [generationTarget, setGenerationTarget] = useState('');
  const [virtualUsers, setVirtualUsers] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = plan?.versions.find((item) => item.version === versionNumber);

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed');
    } finally { setBusy(false); }
  }

  function edit(version: PlanVersion) {
    setVersionNumber(version.version); setRequirements(version.requirementsText);
    setDefinition(version.script ? JSON.stringify({ targetId: version.script.definition.targetId,
      workload: version.script.definition.workload, scenarios: version.script.definition.scenarios }, null, 2) : '');
    setSpecification(''); setConfirmed(false);
    if (version.script) {
      setGenerationTarget(version.script.definition.targetId);
      setVirtualUsers(String(version.script.definition.workload.virtualUsers));
      setDurationSeconds(String(version.script.definition.workload.durationSeconds));
    }
  }

  async function load(id: string) {
    const result = await api<Plan>(`/plans/${id}`);
    setPlan(result); setName(result.name); edit(result.versions[result.versions.length - 1]);
  }

  async function list() {
    const result = await api<{ items: Plan[] }>(`/projects/${projectId}/plans`);
    setPlans(result.items);
  }

  async function save() {
    const body = { requirementsText: requirements,
      ...(specification.trim() ? { specification: JSON.parse(specification) as unknown } : {}),
      ...(definition.trim() ? { script: JSON.parse(definition) as unknown } : {}),
    };
    if (plan) {
      await api(`/plans/${plan.id}/versions`, { ...body, expectedVersion: plan.currentVersion });
      await load(plan.id);
    } else {
      const result = await api<Plan>(`/projects/${projectId}/plans`, { name, ...body });
      setPlan(result); edit(result.versions[0]);
    }
    await list(); setMessage('Saved. A new script requires review.');
  }

  async function download() {
    if (!plan || !selected) return;
    const response = await fetch(`/api/v1/plans/${plan.id}/versions/${selected.version}/script`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Download failed. Review the script first.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url;
    link.download = `plan-${plan.id}-v${selected.version}.js`; link.click();
    URL.revokeObjectURL(url);
  }

  return <main>
    <header><p>AI performance testing agent · Phase 5</p><h1>Plan, run, and report</h1>
      <p>Keep requirements and k6 scripts in reproducible versions. Script review is separate from run approval.</p></header>
    <section aria-labelledby="connection"><h2 id="connection">Connect to your project</h2>
      <p>Local Test User · local-test@example.test</p>
      <p>Enter a project belonging to this local user.</p>
      <label>Project ID<input value={projectId} onChange={(event) => {
        setProjectId(event.target.value); setPlans([]); setPlan(null); setConfirmed(false);
      }} /></label>
      <button disabled={busy || !projectId} onClick={() => void action(list)}>Load plans</button>
    </section>
    <div role="status" aria-live="polite">{busy ? 'Working…' : message}</div>
    <div className="columns"><section aria-labelledby="saved"><h2 id="saved">Saved plans</h2>
      {plans.map((item) => <button className="plan" key={item.id} disabled={busy}
        onClick={() => void action(() => load(item.id))}>{item.name} · v{item.currentVersion}</button>)}
      {!plans.length && <p>Load a project or create its first plan.</p>}
      <button disabled={busy} onClick={() => { setPlan(null); setName(''); setRequirements('');
        setSpecification(''); setDefinition(''); setConfirmed(false); }}>New plan</button>
    </section><section aria-labelledby="editor"><h2 id="editor">{plan ? 'Create the next version' : 'Create a plan'}</h2>
      <label>Name<input value={name} disabled={!!plan} onChange={(event) => setName(event.target.value)} /></label>
      <label>Requirements<textarea rows={5} maxLength={20000} value={requirements} onChange={(event) => setRequirements(event.target.value)} /></label>
      <label>OpenAPI 3.0 / 3.1 JSON (optional)<textarea rows={5} value={specification} onChange={(event) => setSpecification(event.target.value)} /></label>
      <p>Only operation methods and paths are retained. Examples, server URLs, and descriptions are discarded.</p>
      <label>Script definition JSON (optional)<textarea rows={10} value={definition}
        placeholder={'{"targetId":"registered-target-uuid","workload":{"virtualUsers":1,"durationSeconds":10},"scenarios":[{"name":"Health","method":"GET","path":"/health","expectedStatus":200}]}'}
        onChange={(event) => setDefinition(event.target.value)} /></label>
      <p>Use a target registered in this project. Configure approved workload limits on the API. Requests use literal paths without query strings, headers, or bodies.</p>
      <button disabled={busy || !projectId || !requirements.trim() || !name.trim()} onClick={() => void action(save)}>Save {plan ? 'new version' : 'plan'}</button>
    </section></div>
    {plan && <section aria-labelledby="generation"><h2 id="generation">Generate with Groq</h2>
      <p>Generate from saved version {versionNumber}. Groq receives its requirements and normalized operation methods/paths.
        Configure the API key and model in the API’s .env file. Generated content is saved as a new version for review.</p>
      <label>Registered target ID<input value={generationTarget} onChange={(event) => setGenerationTarget(event.target.value)} /></label>
      <label>Virtual users<input type="number" min="1" step="1" value={virtualUsers} onChange={(event) => setVirtualUsers(event.target.value)} /></label>
      <label>Duration in seconds<input type="number" min="1" step="1" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} /></label>
      <button disabled={busy || !generationTarget || versionNumber !== plan.currentVersion ||
        !Number.isSafeInteger(Number(virtualUsers)) || Number(virtualUsers) < 1 ||
        !Number.isSafeInteger(Number(durationSeconds)) || Number(durationSeconds) < 1}
        onClick={() => void action(async () => {
          await api(`/plans/${plan.id}/generate`, { version: versionNumber, targetId: generationTarget,
            workload: { virtualUsers: Number(virtualUsers), durationSeconds: Number(durationSeconds) } });
          await load(plan.id); await list(); setMessage('Groq generated a new version. Review its script before downloading.');
        })}>Generate scenarios and script</button>
      {versionNumber !== plan.currentVersion && <p>Select the current version to generate.</p>}
    </section>}
    {plan && <section aria-labelledby="review"><h2 id="review">Review saved content</h2>
      <label>Version<select value={versionNumber} onChange={(event) => {
        const version = plan.versions.find((item) => item.version === Number(event.target.value));
        if (version) edit(version);
      }}>{plan.versions.map((item) => <option key={item.version} value={item.version}>Version {item.version}</option>)}</select></label>
      <pre>{selected?.requirementsText}</pre>
      {selected?.specification != null && <pre>{JSON.stringify(selected.specification, null, 2)}</pre>}
      {selected?.script ? <>
        <p>Validation: {selected.script.validationStatus} · Review: {selected.script.reviewStatus}</p>
        <pre>{selected.script.content}</pre><p className="checksum">SHA-256: {selected.script.sha256}</p>
        <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I reviewed this saved script, destination, and workload.</label>
        <button disabled={busy || !confirmed} onClick={() => void action(async () => {
          await api(`/plans/${plan.id}/versions/${selected.version}/review`, { reviewed: true, sha256: selected.script?.sha256 });
          const updated = await api<Plan>(`/plans/${plan.id}`); setPlan(updated); setMessage('Script review recorded.');
        })}>Record review</button>
        <button disabled={busy || selected.script.reviewStatus !== 'reviewed'} onClick={() => void action(download)}>Download k6 script</button>
      </> : <p>This version has no script. Add a script definition and save a new version.</p>}
    </section>}
    {plan && selected && <RunPanel key={`${plan.id}:${selected.version}`} planId={plan.id} version={selected} />}
    {plan && <ProjectDataPanel key={projectId} projectId={projectId} />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
