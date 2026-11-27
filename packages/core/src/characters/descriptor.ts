/**
 * Character descriptor (D-032): the canonical words for a recurring
 * character, split by what keeps it recognisable (face, hair, build, outfit).
 * It is locked once a sheet is saved: changing it makes a new version of the
 * character, and a wardrobe change is an explicit outfit variant. Every shot
 * that shows the character gets these exact words (`descriptorToShotCharacter`)
 * next to its reference pictures.
 */
import { z } from 'zod';
import { CHARACTER_KINDS, type CharacterKind, type ShotCharacter } from '../prompting/shot';

const Field = (max: number) => z.string().trim().max(max);

export const CharacterDescriptorSchema = z.object({
  kind: z.enum(CHARACTER_KINDS).default('person'),
  /** A person: age band and face (shape, eyes, skin, marks). An animal: species, coat, markings. A thing: shape, material, color, label. */
  face: Field(300).default(''),
  /** A person's hair (color, length, style). */
  hair: Field(160).optional(),
  /** Build and height. An animal: size and build. */
  build: Field(160).optional(),
  /** The default outfit (a person) or a fixed accessory or state (an animal or a thing). */
  outfit: Field(240).optional(),
  /** Look of the sheet pictures (medium, palette): "photoreal", "anime". */
  style: Field(200).optional(),
});
export type CharacterDescriptor = z.infer<typeof CharacterDescriptorSchema>;

/** A wardrobe change: its own name and outfit words; face, hair and build stay locked. */
export const OutfitInputSchema = z.object({ name: Field(60).min(1), outfit: Field(240).min(1) });
export type OutfitInput = z.infer<typeof OutfitInputSchema>;

export interface OutfitVariant extends OutfitInput {
  id: string;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');

/** True when the descriptor says nothing a model could draw. */
export function descriptorIsEmpty(d: Pick<CharacterDescriptor, 'face' | 'hair' | 'build' | 'outfit'>): boolean {
  return ![d.face, d.hair, d.build, d.outfit].some((x) => clean(x) !== '');
}

/** The locked look (face, hair, build) as one phrase, capped to what a shot character takes. */
export function descriptorLook(d: Pick<CharacterDescriptor, 'face' | 'hair' | 'build'>): string {
  const parts = [clean(d.face), clean(d.hair), clean(d.build)].filter(Boolean);
  const look = parts.join('; ');
  return look.length <= 240 ? look : look.slice(0, 240).replace(/[;,]?\s+\S*$/, '');
}

/** The descriptor as a shot character: the same words in every shot it appears in. An outfit variant replaces the outfit only. */
export function descriptorToShotCharacter(name: string, d: CharacterDescriptor, outfit?: Pick<OutfitVariant, 'outfit'> | null): ShotCharacter {
  const wardrobe = clean(outfit?.outfit ?? d.outfit).slice(0, 200);
  const look = descriptorLook(d) || name;
  return { name: name.slice(0, 40), ...(d.kind !== 'person' && { kind: d.kind as CharacterKind }), look, ...(wardrobe && { wardrobe }) };
}

/** Stable comparison: two descriptors that draw the same character. */
export function sameDescriptor(a: CharacterDescriptor, b: CharacterDescriptor): boolean {
  const k = (d: CharacterDescriptor) => [d.kind, clean(d.face), clean(d.hair), clean(d.build), clean(d.outfit), clean(d.style)].join('|').toLowerCase();
  return k(a) === k(b);
}

/** The variant a shot's wardrobe names ("office suit" matches the variant "Office suit" or one whose name it contains). */
export function matchOutfit<T extends Pick<OutfitVariant, 'name'>>(variants: readonly T[], wardrobe: string | undefined): T | null {
  const w = clean(wardrobe).toLowerCase();
  if (!w) return null;
  return variants.find((v) => v.name.toLowerCase() === w) ?? variants.find((v) => w.includes(v.name.toLowerCase()) && v.name.length >= 3) ?? null;
}
