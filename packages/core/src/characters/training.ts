/**
 * Character training (LoRA or identity) through the gateway (D-032).
 *
 * The Hyperouter catalog (checked 2026-11-27, 61 models) has no training
 * endpoint and no identity-embedding model. `lumina/w2.2-i2v-lora` applies
 * LoRA weights by URL (`loras`, `high_noise_loras`, `low_noise_loras`, up to
 * 3 each), but nothing on the gateway produces those weights. "Train this
 * character" is therefore not offered; the decision lists the provider
 * options. `trainingAvailability` reads the live catalog so the option turns
 * on by itself if the gateway adds a training model.
 */
import type { ListingModel } from '../models/types';

export interface TrainingAvailability {
  available: boolean;
  /** Gateway models that apply trained weights (inference only). */
  appliesLoras: string[];
  /** Gateway models that train weights or identities. */
  trains: string[];
}

const LORA_PARAMS = ['loras', 'high_noise_loras', 'low_noise_loras'];

export function trainingAvailability(models: readonly Pick<ListingModel, 'id' | 'operations' | 'unmappedOperations' | 'acceptedParams'>[]): TrainingAvailability {
  const appliesLoras = models.filter((m) => m.acceptedParams.some((p) => LORA_PARAMS.includes(p))).map((m) => m.id);
  const trains = models.filter((m) => m.unmappedOperations.some((o) => /train|fine.?tune/i.test(o)) || /(^|\/)(lora-?train|trainer)/i.test(m.id)).map((m) => m.id);
  return { available: trains.length > 0, appliesLoras, trains };
}
