/**
 * Shared prompt box and its layers (handoff 3). Import from `@/features/prompt`
 * (or a relative path until the alias exists).
 */
export { PromptBox, type PromptBoxProps, type PillPopoverState } from './PromptBox';
export { ReferencePicker, type ReferencePickerProps } from './ReferencePicker';
export { CommandPalette, type CommandPaletteProps } from './CommandPalette';
export { PlusMenu, type PlusMenuProps, type PlusAction } from './PlusMenu';
export { RefChips, SkillChip, type RefChipsProps, type SkillChipProps } from './RefChips';
export { CostLine, type CostLineProps } from './CostLine';
export { Presence, type PresenceProps } from './Presence';
export { PromptIcon, promptIcons, type PromptIconName } from './icons';
export {
  COMMAND,
  useDefaultCommandGroups,
  filterCommands,
  isSlashQuery,
  trailingAtQuery,
  stripTrailingAt,
} from './commands';
export { useReferences, useSkills, fetchReferences, fetchSkills, promptKeys, uploadReferences } from './api';
export type {
  RefItem,
  RefSource,
  RefGroup,
  RefTab,
  RefGlyph,
  PromptPill,
  PromptCommand,
  PromptCommandGroup,
  PromptMode,
} from './types';
