import { cx } from '@rolling/ui';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { MenuPopover } from '@/features/canvas/layers/Menu';
import { AGENT_MODES, budgetChoices, type AgentMode } from './useAgentMode';
import styles from './agentMode.module.css';

export interface AgentModeSwitchProps {
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  /** Auto: credits per turn, the confirm threshold (the default) and the setter (null = follow the threshold). */
  budget: number;
  threshold: number;
  onBudgetChange: (credits: number | null) => void;
  /** Where the menus open. */
  side?: 'top' | 'bottom';
  /** Pill class of the surrounding control row, so the switch matches the model pills. */
  pillClassName?: string;
}

/**
 * D-021 mode switch (Read / Edit / Auto), a pill next to the agent model picker.
 * The pill and each row carry a one-line tooltip. In Auto, the per-turn run
 * budget pill follows it.
 */
export function AgentModeSwitch({ mode, onModeChange, budget, threshold, onBudgetChange, side = 'top', pillClassName }: AgentModeSwitchProps) {
  const intl = useIntl();
  const [menu, setMenu] = useState<'mode' | 'budget' | null>(null);
  const name = (m: AgentMode) => intl.formatMessage({ id: `agent.mode.${m}` });
  const hint = (m: AgentMode) => intl.formatMessage({ id: `agent.mode.${m}.hint` });
  const choices = budgetChoices(budget, threshold);
  return (
    <>
      <MenuPopover
        open={menu === 'mode'}
        onOpenChange={(o) => setMenu(o ? 'mode' : null)}
        label={intl.formatMessage({ id: 'agent.mode.label' })}
        title={intl.formatMessage({ id: 'agent.mode.label' })}
        side={side}
        entries={AGENT_MODES.map((m) => ({ key: m, label: name(m), meta: hint(m), hint: hint(m), checked: m === mode, onSelect: () => onModeChange(m) }))}
        trigger={(t) => (
          <button
            {...t}
            type="button"
            className={cx(pillClassName, styles.modePill)}
            aria-label={`${intl.formatMessage({ id: 'agent.mode.label' })}: ${name(mode)}`}
            title={hint(mode)}
            data-testid="agent-mode"
            data-mode={mode}
          >
            {name(mode)}
          </button>
        )}
      />
      {mode === 'auto' ? (
        <MenuPopover
          open={menu === 'budget'}
          onOpenChange={(o) => setMenu(o ? 'budget' : null)}
          label={intl.formatMessage({ id: 'agent.budget.label' })}
          title={intl.formatMessage({ id: 'agent.budget.label' })}
          side={side}
          entries={choices.map((n) => ({
            key: String(n),
            label: intl.formatMessage({ id: n === threshold ? 'agent.budget.optionDefault' : 'agent.budget.option' }, { n }),
            checked: n === budget,
            onSelect: () => onBudgetChange(n === threshold ? null : n),
          }))}
          trigger={(t) => (
            <button {...t} type="button" className={styles.budget} aria-label={intl.formatMessage({ id: 'agent.budget.label' })} title={intl.formatMessage({ id: 'agent.budget.hint' })} data-testid="agent-budget">
              <FormattedMessage id="agent.budget.pill" values={{ n: budget }} />
            </button>
          )}
        />
      ) : null}
    </>
  );
}
