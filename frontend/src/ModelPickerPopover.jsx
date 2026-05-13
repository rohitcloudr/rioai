import { useEffect, useMemo, useRef, useState } from 'react';
import {
  rioAlias,
  PROVIDER_SHORT,
  PROVIDER_TAGLINE,
  MODEL_DESC,
  GENERIC_MODEL_DESC,
} from './modelMeta.js';

/**
 * Provider/model picker shown as a popover.
 *  • value         { provider, model } | null   (null = Auto if allowAuto)
 *  • onChange      (next value) => void
 *  • modelOptions  flat list from App.jsx
 *  • allowAuto     show an "Auto" option above the provider tabs
 *  • variant       "light" (default, header) | "dark" (call overlay)
 */
export default function ModelPickerPopover({
  value,
  onChange,
  modelOptions = [],
  allowAuto = false,
  variant = 'light',
}) {
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState(null);
  const rootRef = useRef(null);

  // Group flat options by provider for the panel.
  const groups = useMemo(() => {
    const map = new Map();
    for (const o of modelOptions) {
      if (!map.has(o.provider)) {
        map.set(o.provider, {
          name: o.provider,
          label: o.providerLabel,
          options: [],
        });
      }
      map.get(o.provider).options.push(o);
    }
    return Array.from(map.values());
  }, [modelOptions]);

  // When opening, default the active tab to the value's provider (if any),
  // otherwise the first available provider.
  useEffect(() => {
    if (!open) return;
    if (activeProvider && groups.find((g) => g.name === activeProvider)) return;
    setActiveProvider(value?.provider ?? groups[0]?.name ?? null);
  }, [open, value, groups, activeProvider]);

  // Close on click-outside and Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isEmpty = value == null;
  const isAuto = isEmpty && allowAuto; // null + allowAuto → "Auto"; null without allowAuto → unset
  const triggerAlias = isAuto
    ? 'Auto'
    : isEmpty
      ? 'Choose model'
      : rioAlias(value.model);
  const triggerSub = isAuto
    ? 'smart fallback'
    : isEmpty
      ? 'click to pick'
      : (MODEL_DESC[value.model] ?? GENERIC_MODEL_DESC);

  const activeModels =
    groups.find((g) => g.name === activeProvider)?.options ?? [];

  function pick(next) {
    onChange?.(next);
    setOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className={`mp-root mp-${variant} ${open ? 'mp-open' : ''} ${isEmpty && !allowAuto ? 'mp-needs-pick' : ''}`}
    >
      <button
        type="button"
        className="mp-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          isAuto
            ? 'Auto: Rio picks the best model for you'
            : isEmpty
              ? 'No model selected — click to choose'
              : `${rioAlias(value.model)} — ${MODEL_DESC[value.model] ?? GENERIC_MODEL_DESC}`
        }
      >
        <span className="mp-trigger-tag">{triggerAlias}</span>
        <span className="mp-trigger-sub">{triggerSub}</span>
        <span className="mp-chev" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="mp-panel" role="listbox" aria-label="Choose AI model">
          <div className="mp-tabs" role="tablist">
            {allowAuto && (
              <button
                type="button"
                role="tab"
                className={`mp-tab ${isAuto ? 'mp-tab-active' : ''}`}
                onClick={() => pick(null)}
                aria-selected={isAuto}
              >
                <span className="mp-tab-name">Auto</span>
                <span className="mp-tab-tag">smart fallback (recommended)</span>
              </button>
            )}
            {groups.map((g) => (
              <button
                type="button"
                role="tab"
                key={g.name}
                className={`mp-tab ${activeProvider === g.name ? 'mp-tab-active' : ''}`}
                onClick={() => setActiveProvider(g.name)}
                aria-selected={activeProvider === g.name}
              >
                <span className="mp-tab-name">{PROVIDER_SHORT[g.name] ?? g.label}</span>
                <span className="mp-tab-tag">{PROVIDER_TAGLINE[g.name] ?? g.label}</span>
              </button>
            ))}
          </div>

          <div className="mp-list">
            {activeModels.length === 0 ? (
              <p className="mp-empty">No models available for this provider.</p>
            ) : (
              activeModels.map((o) => {
                const active =
                  !isEmpty &&
                  value?.provider === o.provider &&
                  value?.model === o.model;
                return (
                  <button
                    type="button"
                    role="option"
                    key={o.value}
                    className={`mp-item ${active ? 'mp-item-active' : ''}`}
                    onClick={() => pick({ provider: o.provider, model: o.model })}
                    aria-selected={active}
                  >
                    <span className="mp-item-alias">{o.label}</span>
                    <span className="mp-item-desc">
                      {MODEL_DESC[o.model] ?? GENERIC_MODEL_DESC}
                    </span>
                    {active && <span className="mp-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
