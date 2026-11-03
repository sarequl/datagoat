import { useState } from 'react';
import type { FunnelDefinition, FunnelStep, FunnelStepType } from '../api/types';
import { useFunnelMutations } from '../hooks/useFunnels';
import { useSelectedSite } from '../hooks/useSelectedSite';
import { emptyFunnelStep, FUNNEL_STEP_SCHEMA, FUNNEL_STEP_TYPES } from '../utils/funnelSteps';

interface StepDraft {
  key: string;
  step: FunnelStep;
}

let stepDraftSeq = 0;

function makeStepDraft(step: FunnelStep): StepDraft {
  stepDraftSeq += 1;
  return { key: `step_${stepDraftSeq}`, step };
}

interface StepFieldInputsProps {
  step: FunnelStep;
  onChange: (step: FunnelStep) => void;
}

function StepFieldInputs({ step, onChange }: StepFieldInputsProps) {
  const schema = FUNNEL_STEP_SCHEMA[step.type];

  function setParam(name: string, value: unknown) {
    onChange({ ...step, [name]: value });
  }

  if (step.type === 'referrer') {
    const mode = step.referrer !== undefined ? 'referrer' : 'referrerContains';
    return (
      <>
        <label>
          Match
          <select
            className="form-select"
            value={mode}
            onChange={(event) => {
              const next = { ...step };
              if (event.target.value === 'referrer') {
                next.referrer = '';
                delete next.referrerContains;
              } else {
                next.referrerContains = '';
                delete next.referrer;
              }
              onChange(next);
            }}
          >
            <option value="referrer">Referrer equals</option>
            <option value="referrerContains">Referrer contains</option>
          </select>
        </label>
        <label>
          Value
          <input
            className="form-input"
            value={mode === 'referrer' ? (step.referrer ?? '') : (step.referrerContains ?? '')}
            onChange={(event) => setParam(mode, event.target.value)}
          />
        </label>
      </>
    );
  }

  return (
    <>
      {schema.fields.map((field) => {
        if (field.kind === 'boolean') {
          return (
            <label key={field.name}>
              {schema.label}
              <input
                type="checkbox"
                checked={Boolean(step[field.name as keyof FunnelStep])}
                onChange={(event) => setParam(field.name, event.target.checked)}
              />
            </label>
          );
        }
        if (field.kind === 'device') {
          return (
            <label key={field.name}>
              Device
              <select
                className="form-select"
                value={step.device ?? 'desktop'}
                onChange={(event) => setParam('device', event.target.value)}
              >
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
                <option value="tablet">Tablet</option>
              </select>
            </label>
          );
        }
        return (
          <label key={field.name}>
            {field.name}
            <input
              className="form-input"
              type={field.kind === 'number' ? 'number' : 'text'}
              value={String(step[field.name as keyof FunnelStep] ?? '')}
              onChange={(event) =>
                setParam(
                  field.name,
                  field.kind === 'number' ? Number(event.target.value) : event.target.value,
                )
              }
            />
          </label>
        );
      })}
    </>
  );
}

interface FunnelBuilderProps {
  funnel?: FunnelDefinition;
  onDone: (funnelId: string) => void;
  onCancel: () => void;
}

export function FunnelBuilder({ funnel, onDone, onCancel }: FunnelBuilderProps) {
  const { selectedSite } = useSelectedSite();
  const { create, update } = useFunnelMutations(selectedSite?.id);
  const [name, setName] = useState(funnel?.name ?? '');
  const [isActive, setIsActive] = useState(funnel?.isActive ?? true);
  const [maxGap, setMaxGap] = useState(funnel?.maxGapSeconds?.toString() ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    (funnel?.steps ?? [emptyFunnelStep('page'), emptyFunnelStep('goal')]).map((step) =>
      makeStepDraft({ ...step }),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const isPending = create.isPending || update.isPending;

  function updateStep(index: number, step: FunnelStep) {
    setSteps((current) =>
      current.map((draft, itemIndex) => (itemIndex === index ? { ...draft, step } : draft)),
    );
  }

  async function handleSave() {
    setError(null);
    if (name.trim().length === 0) {
      setError('Name is required.');
      return;
    }
    if (steps.length < 2 || steps.length > 8) {
      setError('A funnel needs 2-8 steps.');
      return;
    }

    const trimmedGap = maxGap.trim();
    let maxGapSeconds: number | null = null;
    if (trimmedGap !== '') {
      const parsed = Number(trimmedGap);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError('Max gap seconds must be a positive integer.');
        return;
      }
      maxGapSeconds = parsed;
    }

    try {
      const body = {
        name: name.trim(),
        isActive,
        maxGapSeconds,
        steps: steps.map((draft) => draft.step),
      };
      const saved = funnel
        ? await update.mutateAsync({ funnelId: funnel.id, body })
        : await create.mutateAsync(body);
      onDone(saved.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the funnel.');
    }
  }

  return (
    <section className="funnel-builder" aria-label={funnel ? 'Edit funnel' : 'New funnel'}>
      <h2>{funnel ? 'Edit funnel' : 'New funnel'}</h2>

      <div className="funnel-builder__form">
        <label>
          Name
          <input
            className="form-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Active
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
        </label>
        <label>
          Max gap seconds (optional)
          <input
            className="form-input"
            type="number"
            min={1}
            value={maxGap}
            onChange={(event) => setMaxGap(event.target.value)}
            placeholder="No cap"
          />
        </label>
      </div>

      <h3>Steps</h3>
      <ol className="funnel-steps">
        {steps.map((draft, index) => (
          <li key={draft.key} className="funnel-step-editor">
            <div className="funnel-step-editor__header">
              <span>Step {index + 1}</span>
              <button
                type="button"
                onClick={() =>
                  setSteps((current) => current.filter((item) => item.key !== draft.key))
                }
                disabled={steps.length <= 2}
              >
                Remove
              </button>
            </div>
            <label>
              Type
              <select
                className="form-select"
                value={draft.step.type}
                onChange={(event) =>
                  updateStep(index, emptyFunnelStep(event.target.value as FunnelStepType))
                }
              >
                {FUNNEL_STEP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {FUNNEL_STEP_SCHEMA[type].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Label (optional)
              <input
                className="form-input"
                value={draft.step.name ?? ''}
                onChange={(event) => updateStep(index, { ...draft.step, name: event.target.value })}
              />
            </label>
            <StepFieldInputs step={draft.step} onChange={(next) => updateStep(index, next)} />
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => setSteps((current) => [...current, makeStepDraft(emptyFunnelStep('page'))])}
        disabled={steps.length >= 8}
      >
        Add step
      </button>

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      <div className="funnel-builder__actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" onClick={handleSave} disabled={isPending}>
          {funnel ? 'Save changes' : 'Create funnel'}
        </button>
      </div>
    </section>
  );
}
