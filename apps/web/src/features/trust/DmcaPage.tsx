import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { submitCounterNotice, submitDmca } from './api';
import { PageFrame } from './PageFrame';
import { useSubmit } from './useSubmit';
import styles from './Trust.module.css';

type Fields = Record<string, string>;

function Text({ name, values, set, multiline, type = 'text', required = true }: { name: string; values: Fields; set: (k: string, v: string) => void; multiline?: boolean; type?: string; required?: boolean }) {
  return (
    <label className={styles.field}>
      <FormattedMessage id={`trust.dmca.field.${name}`} />
      {multiline ? (
        <textarea className={styles.textarea} required={required} maxLength={4000} value={values[name] ?? ''} onChange={(e) => set(name, e.target.value)} />
      ) : (
        <input className={styles.input} type={type} required={required} value={values[name] ?? ''} onChange={(e) => set(name, e.target.value)} />
      )}
    </label>
  );
}

function Check({ name, checked, set }: { name: string; checked: boolean; set: (v: boolean) => void }) {
  return (
    <label className={styles.check}>
      <input type="checkbox" required checked={checked} onChange={(e) => set(e.target.checked)} />
      <span><FormattedMessage id={`trust.dmca.statement.${name}`} /></span>
    </label>
  );
}

function Done({ title, body, id }: { title: string; body: string; id: string }) {
  return (
    <PageFrame>
      <h1 className={styles.h1}><FormattedMessage id={title} /></h1>
      <p className={styles.sub} role="status"><FormattedMessage id={body} values={{ id }} /></p>
      <Link to="/" className={styles.link}><FormattedMessage id="trust.backHome" /></Link>
    </PageFrame>
  );
}

/** `/dmca` (public, D-028): a takedown notice with the elements of 17 U.S.C. § 512(c)(3). */
export function DmcaPage() {
  const intl = useIntl();
  const [v, setV] = useState<Fields>({});
  const [checks, setChecks] = useState({ goodFaith: false, accuracy: false });
  const s = useSubmit(submitDmca, intl.formatMessage({ id: 'trust.error' }));
  const set = (k: string, val: string) => setV((x) => ({ ...x, [k]: val }));
  if (s.caseId) return <Done title="trust.dmca.doneTitle" body="trust.dmca.done" id={s.caseId} />;
  return (
    <PageFrame>
      <h1 className={styles.h1}><FormattedMessage id="trust.dmca.title" /></h1>
      <p className={styles.sub}><FormattedMessage id="trust.dmca.sub" /></p>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          s.submit({
            fullName: v.fullName,
            ...(v.onBehalfOf ? { onBehalfOf: v.onBehalfOf } : {}),
            email: v.email,
            phone: v.phone,
            address: v.address,
            workDescription: v.workDescription,
            infringingUrls: (v.infringingUrls ?? '').split(/\s+/).filter(Boolean),
            goodFaith: checks.goodFaith,
            accuracyUnderPenalty: checks.accuracy,
            signature: v.signature,
          });
        }}
      >
        <Text name="fullName" values={v} set={set} />
        <Text name="onBehalfOf" values={v} set={set} required={false} />
        <Text name="email" type="email" values={v} set={set} />
        <Text name="phone" type="tel" values={v} set={set} />
        <Text name="address" values={v} set={set} multiline />
        <Text name="workDescription" values={v} set={set} multiline />
        <Text name="infringingUrls" values={v} set={set} multiline />
        <Check name="goodFaith" checked={checks.goodFaith} set={(b) => setChecks((c) => ({ ...c, goodFaith: b }))} />
        <Check name="accuracy" checked={checks.accuracy} set={(b) => setChecks((c) => ({ ...c, accuracy: b }))} />
        <Text name="signature" values={v} set={set} />
        {s.error && <p className={styles.error} role="alert">{s.error}</p>}
        <button type="submit" className={styles.submit} disabled={s.busy}><FormattedMessage id="trust.dmca.submit" /></button>
      </form>
    </PageFrame>
  );
}

/** `/dmca/counter` (signed in, D-028): a counter-notice with the elements of 17 U.S.C. § 512(g)(3). */
export function CounterNoticePage({ caseId }: { caseId?: string }) {
  const intl = useIntl();
  const [v, setV] = useState<Fields>({ caseId: caseId ?? '' });
  const [checks, setChecks] = useState({ mistake: false, jurisdiction: false, service: false });
  const s = useSubmit(submitCounterNotice, intl.formatMessage({ id: 'trust.error' }));
  const set = (k: string, val: string) => setV((x) => ({ ...x, [k]: val }));
  if (s.caseId) return <Done title="trust.counter.doneTitle" body="trust.counter.done" id={s.caseId} />;
  return (
    <PageFrame>
      <h1 className={styles.h1}><FormattedMessage id="trust.counter.title" /></h1>
      <p className={styles.sub}><FormattedMessage id="trust.counter.sub" /></p>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          s.submit({
            caseId: v.caseId,
            fullName: v.fullName,
            email: v.email,
            phone: v.phone,
            address: v.address,
            materialDescription: v.materialDescription,
            mistakeUnderPenalty: checks.mistake,
            consentToJurisdiction: checks.jurisdiction,
            acceptService: checks.service,
            signature: v.signature,
          });
        }}
      >
        <Text name="caseId" values={v} set={set} />
        <Text name="fullName" values={v} set={set} />
        <Text name="email" type="email" values={v} set={set} />
        <Text name="phone" type="tel" values={v} set={set} />
        <Text name="address" values={v} set={set} multiline />
        <Text name="materialDescription" values={v} set={set} multiline />
        <Check name="mistake" checked={checks.mistake} set={(b) => setChecks((c) => ({ ...c, mistake: b }))} />
        <Check name="jurisdiction" checked={checks.jurisdiction} set={(b) => setChecks((c) => ({ ...c, jurisdiction: b }))} />
        <Check name="service" checked={checks.service} set={(b) => setChecks((c) => ({ ...c, service: b }))} />
        <Text name="signature" values={v} set={set} />
        {s.error && <p className={styles.error} role="alert">{s.error}</p>}
        <button type="submit" className={styles.submit} disabled={s.busy}><FormattedMessage id="trust.counter.submit" /></button>
      </form>
    </PageFrame>
  );
}
