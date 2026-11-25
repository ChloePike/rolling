import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Popover, SegmentedControl, Switch, Tabs, ToastProvider, useToast } from '../index';
import { presenceProps, staggerStyle, usePresence } from '../motion';

afterEach(cleanup);

describe('Switch', () => {
  it('exposes role="switch" with aria-checked and toggles on click', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} aria-label="Notify when done" />);
    const sw = screen.getByRole('switch', { name: 'Notify when done' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('SegmentedControl', () => {
  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
    return (
      <SegmentedControl
        label="Aspect ratio"
        value={value}
        onValueChange={setValue}
        options={[
          { value: 'a', label: '9:16' },
          { value: 'b', label: '16:9', disabled: true },
          { value: 'c', label: '1:1' },
        ]}
      />
    );
  }

  it('is a radiogroup with one tab stop and arrow keys skip disabled options', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    const radios = screen.getAllByRole('radio');
    expect(group).toBeTruthy();
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: '1:1' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '1:1' }));
  });
});

describe('Tabs', () => {
  it('marks the selected tab and wraps with ArrowLeft', () => {
    function Harness() {
      const [v, setV] = useState('all');
      return (
        <Tabs
          label="Sources"
          value={v}
          onValueChange={setV}
          items={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'My assets' },
          ]}
        />
      );
    }
    render(<Harness />);
    const all = screen.getByRole('tab', { name: 'All' });
    expect(all.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'My assets' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Toast', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <>
        <Button onClick={() => toast.show({ message: 'First', duration: 0 })}>one</Button>
        <Button
          onClick={() => toast.show({ message: 'Run failed. Refunded 8 credits.', action: { label: 'Retry', onAction: retry } })}
        >
          two
        </Button>
      </>
    );
  }
  const retry = vi.fn();

  it('shows one toast at a time, runs the action and auto-dismisses', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider dismissLabel="Dismiss">
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('one'));
    expect(screen.getByRole('status').textContent).toContain('First');
    fireEvent.click(screen.getByText('two'));
    expect(screen.getByRole('status').textContent).not.toContain('First');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(screen.getByText('two'));
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(screen.getByRole('status').textContent).toBe('');
    vi.useRealTimers();
  });
});

describe('Dialog', () => {
  it('is modal, labelled by its title, and closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Run 3 nodes?" closeLabel="Close">
        <Button variant="primary">Run</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Run 3 nodes?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Popover', () => {
  it('wires aria-expanded on the trigger and closes on Escape, returning focus', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Popover open={open} onOpenChange={setOpen} label="Settings" trigger={(p) => <button {...p}>gear</button>}>
          <button>inside</button>
        </Popover>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText('gear');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('inside'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('motion helpers', () => {
  it('usePresence keeps the element mounted for the exit, then unmounts', () => {
    vi.useFakeTimers();
    function Harness({ open }: { open: boolean }) {
      const p = usePresence(open, 140);
      return p.mounted ? <div data-testid="layer" {...presenceProps(p.state)} /> : null;
    }
    const { rerender } = render(<Harness open />);
    expect(screen.getByTestId('layer').getAttribute('data-state')).toBe('open');
    rerender(<Harness open={false} />);
    const layer = screen.getByTestId('layer');
    expect(layer.getAttribute('data-state')).toBe('closed');
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(141);
    });
    expect(screen.queryByTestId('layer')).toBeNull();
    vi.useRealTimers();
  });

  it('staggerStyle caps the index at the sixth row', () => {
    expect(staggerStyle(0)).toEqual({ '--rl-i': 0 });
    expect(staggerStyle(9)).toEqual({ '--rl-i': 5 });
  });
});
