/**
 * Brand kit (D-035), per workspace: logo from Assets, brand colors, uploaded
 * fonts (with the license note), intro and end cards, the logo watermark and
 * a tone note. Exports apply it when "Apply brand kit" is on; caption looks
 * take its caption font and first color; the agent gets a summary.
 */
import { Dialog, SegmentedControl, Switch, useToast } from '@rolling/ui';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { BRAND_LIMITS, familyFromFileName, fontFormatOf, WATERMARK_POSITIONS, type BrandCard, type BrandKitInput, type WatermarkPosition } from '@rolling/core/post';
import { useAssetPicker } from '@/features/picker';
import { deleteBrandFont, getBrandKit, saveBrandKit, uploadBrandFont, type BrandKitView } from './api';
import styles from './PostDialogs.module.css';
import eStyles from '../Editor.module.css';

const toInput = (k: BrandKitView): BrandKitInput => ({
  logoAssetId: k.logoAssetId,
  colors: k.colors,
  headingFontId: k.headingFontId,
  captionFontId: k.captionFontId,
  intro: k.intro,
  outro: k.outro,
  watermark: k.watermark,
  tone: k.tone,
});

export function BrandKitDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const toast = useToast();
  const picker = useAssetPicker();
  const [kit, setKit] = useState<BrandKitView | null>(null);
  const [draft, setDraft] = useState<BrandKitInput | null>(null);
  // The color picker starts at the UI accent token (a hex in tokens.css).
  const [color, setColor] = useState(() => (typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim().toUpperCase()));
  const [license, setLicense] = useState(false);
  const [busy, setBusy] = useState(false);
  const fontRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void getBrandKit().then((k) => {
      if (!live) return;
      setKit(k);
      setDraft(toInput(k));
    });
    return () => {
      live = false;
    };
  }, [open]);

  // Brand fonts preview in this dialog (FontFace from the signed URL).
  useEffect(() => {
    for (const f of kit?.fonts ?? []) {
      if (!f.url || typeof FontFace === 'undefined') continue;
      const face = new FontFace(f.family, `url(${f.url})`);
      void face.load().then((x) => document.fonts.add(x), () => {});
    }
  }, [kit]);

  const set = (patch: Partial<BrandKitInput>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const card = (key: 'intro' | 'outro', patch: Partial<BrandCard>) => setDraft((d) => (d ? { ...d, [key]: { ...d[key], ...patch } } : d));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const k = await saveBrandKit(draft);
      setKit(k);
      setDraft(toInput(k));
      toast.show({ message: t('post.brand.saved') });
      onClose();
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : t('post.failed') });
    } finally {
      setBusy(false);
    }
  };

  const addFont = async (file: File) => {
    if (!fontFormatOf(file.name, file.type) || file.size > BRAND_LIMITS.fontBytes) return toast.show({ message: t('post.brand.fontTypes') });
    setBusy(true);
    try {
      const k = await uploadBrandFont(file, familyFromFileName(file.name));
      setKit(k);
      setDraft((d) => (d ? { ...d } : toInput(k)));
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : t('post.failed') });
    } finally {
      setBusy(false);
    }
  };

  const removeFont = async (id: string) => {
    const k = await deleteBrandFont(id);
    setKit(k);
    set({ captionFontId: draft?.captionFontId === id ? null : (draft?.captionFontId ?? null), headingFontId: draft?.headingFontId === id ? null : (draft?.headingFontId ?? null) });
  };

  const pickLogo = async () => {
    const picks = await picker.open({ title: t('post.brand.logo'), kinds: ['image'], ...(projectId && { projectId }) });
    if (picks?.[0]) set({ logoAssetId: picks[0].assetId });
  };

  const fontSelect = (label: string, value: string | null, onChange: (v: string | null) => void) => (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <select className={styles.select} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">{t('post.brand.defaultFont')}</option>
        {(kit?.fonts ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.family}
          </option>
        ))}
      </select>
    </label>
  );

  const cardRow = (key: 'intro' | 'outro') => {
    const c = draft![key];
    return (
      <div className={styles.row}>
        <label className={styles.check}>
          <Switch checked={c.enabled} onCheckedChange={(v) => card(key, { enabled: v })} size="sm" aria-label={t(key === 'intro' ? 'post.brand.introCard' : 'post.brand.outroCard')} />
          <span>{t(key === 'intro' ? 'post.brand.introCard' : 'post.brand.outroCard')}</span>
        </label>
        {c.enabled ? (
          <>
            <input className={styles.select} value={c.text} maxLength={BRAND_LIMITS.cardText} placeholder={t('post.brand.cardText')} aria-label={t('post.brand.cardText')} onChange={(e) => card(key, { text: e.target.value })} />
            <SegmentedControl label={t('post.brand.cardText')} value={String(c.seconds)} onValueChange={(v) => card(key, { seconds: Number(v) })} options={['1', '2', '3', '5'].map((s) => ({ value: s, label: t('post.brand.cardSeconds', { s: Number(s) }) }))} />
          </>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.brand.title')} closeLabel={t('post.close')} width={500}>
        {draft ? (
          <div className={styles.body} data-testid="brand-kit-dialog">
            <p className={styles.note}>{t('post.brand.intro')}</p>
            <div className={styles.row}>
              <span className={styles.label}>{t('post.brand.logo')}</span>
              <div className={styles.files}>
                {kit?.logoUrl && draft.logoAssetId === kit.logoAssetId ? <img src={kit.logoUrl} alt="" height={32} /> : <span className={styles.hint}>{t(draft.logoAssetId ? 'post.brand.logoSet' : 'post.brand.logoNone')}</span>}
                <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={() => void pickLogo()}>
                  {t('post.brand.logoPick')}
                </button>
              </div>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>{t('post.brand.colors')}</span>
              <div className={styles.files}>
                {draft.colors.map((c) => (
                  <button key={c} type="button" className={`${eStyles.btn} ${eStyles.secondary}`} aria-label={t('post.brand.colorRemove', { color: c })} onClick={() => set({ colors: draft.colors.filter((x) => x !== c) })}>
                    <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: c, marginRight: 6 }} />
                    {c}
                  </button>
                ))}
                {draft.colors.length < BRAND_LIMITS.colors ? (
                  <>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label={t('post.brand.colorAdd')} />
                    <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={() => !draft.colors.includes(color) && set({ colors: [...draft.colors, color] })}>
                      {t('post.brand.colorAdd')}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>{t('post.brand.fonts')}</span>
              {(kit?.fonts ?? []).map((f) => (
                <div key={f.id} className={styles.files}>
                  <span className={styles.note} style={{ fontFamily: `"${f.family}", sans-serif` }}>
                    {f.family}
                  </span>
                  <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={() => void removeFont(f.id)}>
                    {t('post.brand.fontRemove', { font: f.family })}
                  </button>
                </div>
              ))}
              <label className={styles.check}>
                <input type="checkbox" checked={license} onChange={(e) => setLicense(e.target.checked)} />
                <span>{t('post.brand.fontLicense')}</span>
              </label>
              <p className={styles.hint}>{t('post.brand.fontTypes')}</p>
              <input
                ref={fontRef}
                type="file"
                hidden
                accept=".woff2,.ttf,.otf,font/woff2,font/ttf,font/otf"
                data-testid="brand-font-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void addFont(f);
                }}
              />
              <div className={styles.files}>
                <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} disabled={!license || busy || (kit?.fonts.length ?? 0) >= BRAND_LIMITS.fonts} onClick={() => fontRef.current?.click()}>
                  {t('post.brand.fontUpload')}
                </button>
              </div>
            </div>
            {fontSelect(t('post.brand.captionFont'), draft.captionFontId, (v) => set({ captionFontId: v }))}
            {fontSelect(t('post.brand.headingFont'), draft.headingFontId, (v) => set({ headingFontId: v }))}
            <div className={styles.row}>
              <label className={styles.check}>
                <Switch checked={draft.watermark.enabled} onCheckedChange={(v) => set({ watermark: { ...draft.watermark, enabled: v } })} size="sm" aria-label={t('post.brand.watermark')} />
                <span>{t('post.brand.watermark')}</span>
              </label>
              {draft.watermark.enabled ? (
                <SegmentedControl
                  label={t('post.brand.position')}
                  value={draft.watermark.position}
                  onValueChange={(v) => set({ watermark: { ...draft.watermark, position: v as WatermarkPosition } })}
                  options={WATERMARK_POSITIONS.map((p) => ({ value: p, label: t(`post.brand.position.${p}`) }))}
                />
              ) : null}
            </div>
            {cardRow('intro')}
            {cardRow('outro')}
            <label className={styles.row}>
              <span className={styles.label}>{t('post.brand.tone')}</span>
              <textarea className={styles.text} value={draft.tone} maxLength={BRAND_LIMITS.tone} placeholder={t('post.brand.tonePlaceholder')} onChange={(e) => set({ tone: e.target.value })} />
            </label>
            <div className={styles.actions}>
              <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={onClose}>
                {t('post.cancel')}
              </button>
              <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} disabled={busy} onClick={() => void save()}>
                {t('post.brand.save')}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
      {picker.element}
    </>
  );
}
