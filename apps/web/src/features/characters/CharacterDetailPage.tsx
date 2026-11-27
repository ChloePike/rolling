import { Link } from '@tanstack/react-router';
import { Skeleton } from '@rolling/ui';
import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useCharacter, useRenameCharacter, type CharacterDetail, type DriftSummary, type SheetPicture } from './api';
import styles from './CharacterDetail.module.css';

/**
 * Character page (D-032): the current sheet, the locked descriptor, versions
 * with their drift badge, outfit variants, the projects that used it and the
 * latest consistency checks. Changing the look is a new version (a sheet run
 * from the Characters tool), never an edit in place.
 */
export function CharacterDetailPage({ id }: { id: string }) {
  const q = useCharacter(id);
  if (q.isPending) {
    return (
      <div className={styles.page} aria-busy="true">
        <Skeleton height={36} width={240} radius={10} />
        <Skeleton height={220} radius={18} />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className={styles.page}>
        <p className={styles.empty} role="alert">
          <FormattedMessage id="characters.page.notFound" />
        </p>
        <Link to="/assets" search={{ folder: 'characters' }} className={styles.back}>
          <FormattedMessage id="characters.page.back" />
        </Link>
      </div>
    );
  }
  return <Detail c={q.data} />;
}

function viewLabel(intl: ReturnType<typeof useIntl>, view: string): string {
  return intl.formatMessage({ id: `characters.view.${view}`, defaultMessage: view });
}

function Pictures({ views, testId }: { views: SheetPicture[]; testId?: string }) {
  const intl = useIntl();
  return (
    <ul className={styles.sheet} data-testid={testId}>
      {views.map((p) => (
        <li key={`${p.view}-${p.assetId}`} className={styles.view} data-view={p.view}>
          {p.thumbUrl ?? p.url ? <img src={(p.thumbUrl ?? p.url)!} alt="" loading="lazy" className={styles.img} /> : <span className={styles.placeholder} aria-hidden="true" />}
          <span className={styles.viewLabel}>{viewLabel(intl, p.view)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Consistent · 0.86", "Drift · 0.48": the lowest score of the version's checks. */
export function DriftBadge({ drift }: { drift: DriftSummary | null }) {
  const intl = useIntl();
  if (!drift || drift.verdict === null) {
    return (
      <span className={styles.badge} data-drift="none">
        <FormattedMessage id="characters.drift.none" />
      </span>
    );
  }
  const score = drift.min !== null ? intl.formatNumber(drift.min, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : null;
  return (
    <span className={styles.badge} data-drift={drift.verdict} title={intl.formatMessage({ id: 'characters.drift.title' }, { checks: drift.checks, drifted: drift.drifted })}>
      <FormattedMessage id={`characters.drift.${drift.verdict}`} values={{ score: score ?? '' }} />
    </span>
  );
}

function Detail({ c }: { c: CharacterDetail }) {
  const intl = useIntl();
  const rename = useRenameCharacter(c.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const d = c.descriptor;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (next && next !== c.name) rename.mutate(next);
    setEditing(false);
  };
  const fields: Array<[string, string | undefined]> = d ? [['face', d.face], ['hair', d.hair], ['build', d.build], ['outfit', d.outfit], ['style', d.style]] : [];
  const date = (t: number) => intl.formatDate(t, { dateStyle: 'medium' });
  return (
    <div className={styles.page} data-testid="character-page" data-character={c.id}>
      <Link to="/assets" search={{ folder: 'characters' }} className={styles.back}>
        <FormattedMessage id="characters.page.back" />
      </Link>
      <header className={styles.head}>
        {editing ? (
          <form onSubmit={submit} className={styles.renameForm}>
            <label className={styles.srOnly} htmlFor="character-name">
              <FormattedMessage id="characters.page.name" />
            </label>
            <input id="character-name" className={styles.nameInput} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus onBlur={submit} />
          </form>
        ) : (
          <h1 className={styles.title}>
            <button type="button" className={styles.nameBtn} onClick={() => setEditing(true)} aria-label={intl.formatMessage({ id: 'characters.page.rename' }, { name: c.name })}>
              {rename.variables && rename.isPending ? rename.variables : c.name}
            </button>
          </h1>
        )}
        <DriftBadge drift={c.drift} />
        {c.realFace ? (
          <span className={styles.chip} data-testid="real-face">
            <FormattedMessage id="characters.page.realFace" />
          </span>
        ) : null}
        <span className={styles.spacer} />
        <Link to="/create/character" className={styles.secondary}>
          <FormattedMessage id="characters.page.newVersion" />
        </Link>
      </header>

      <section className={styles.card} aria-labelledby="sheet-title">
        <h2 id="sheet-title" className={styles.cardTitle}>
          <FormattedMessage id="characters.page.sheet" values={{ n: c.versions.find((v) => v.current)?.n ?? 1 }} />
        </h2>
        <Pictures views={c.sheet} testId="character-sheet" />
      </section>

      <div className={styles.columns}>
        <section className={styles.card} aria-labelledby="descriptor-title" data-testid="character-descriptor">
          <div className={styles.cardHead}>
            <h2 id="descriptor-title" className={styles.cardTitle}>
              <FormattedMessage id="characters.page.descriptor" />
            </h2>
            <span className={styles.chip}>
              <FormattedMessage id="characters.page.locked" values={{ n: c.descriptorVersion }} />
            </span>
          </div>
          {fields.length ? (
            <dl className={styles.fields}>
              {fields
                .filter(([, v]) => !!v)
                .map(([k, v]) => (
                  <div key={k} className={styles.field}>
                    <dt>
                      <FormattedMessage id={`characters.field.${k}`} />
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          ) : (
            <p className={styles.muted}>
              <FormattedMessage id="characters.page.noDescriptor" />
            </p>
          )}
          <p className={styles.muted}>
            <FormattedMessage id="characters.page.lockedHint" />
          </p>
        </section>

        <section className={styles.card} aria-labelledby="used-title" data-testid="character-used-in">
          <h2 id="used-title" className={styles.cardTitle}>
            <FormattedMessage id="characters.page.usedIn" />
          </h2>
          {c.usedIn.length ? (
            <ul className={styles.list}>
              {c.usedIn.map((u) => (
                <li key={u.projectId}>
                  <Link to="/p/$projectId" params={{ projectId: u.projectId }} className={styles.rowLink}>
                    <span className={styles.rowTitle}>{u.title}</span>
                    <span className={styles.muted}>
                      <FormattedMessage id="characters.page.uses" values={{ n: u.uses, date: date(u.lastUsedAt) }} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>
              <FormattedMessage id="characters.page.notUsed" />
            </p>
          )}
        </section>
      </div>

      <section className={styles.card} aria-labelledby="versions-title" data-testid="character-versions">
        <h2 id="versions-title" className={styles.cardTitle}>
          <FormattedMessage id="characters.page.versions" />
        </h2>
        <ol className={styles.versions}>
          {c.versions.map((v) => (
            <li key={v.n} className={styles.version} data-version={v.n}>
              <div className={styles.cardHead}>
                <span className={styles.rowTitle}>
                  <FormattedMessage id="characters.page.version" values={{ n: v.n, date: date(v.createdAt) }} />
                </span>
                {v.current ? (
                  <span className={styles.chip}>
                    <FormattedMessage id="characters.page.current" />
                  </span>
                ) : null}
                <DriftBadge drift={v.drift} />
              </div>
              <Pictures views={v.views} />
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.card} aria-labelledby="outfits-title" data-testid="character-outfits">
        <h2 id="outfits-title" className={styles.cardTitle}>
          <FormattedMessage id="characters.page.outfits" />
        </h2>
        {c.outfits.length ? (
          <ul className={styles.versions}>
            {c.outfits.map((o) => (
              <li key={o.id} className={styles.version} data-outfit={o.id}>
                <span className={styles.rowTitle}>{o.name}</span>
                <span className={styles.muted}>{o.outfit}</span>
                <Pictures views={o.views} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>
            <FormattedMessage id="characters.page.noOutfits" />
          </p>
        )}
      </section>

      <section className={styles.card} aria-labelledby="checks-title" data-testid="character-checks">
        <h2 id="checks-title" className={styles.cardTitle}>
          <FormattedMessage id="characters.page.checks" />
        </h2>
        {c.checks.length ? (
          <ul className={styles.list}>
            {c.checks.map((k) => (
              <li key={k.id} className={styles.check} data-verdict={k.verdict}>
                {k.thumbUrl ? <img src={k.thumbUrl} alt="" className={styles.checkImg} loading="lazy" /> : <span className={styles.checkImg} aria-hidden="true" />}
                <span className={styles.rowTitle}>
                  <FormattedMessage id={`characters.check.${k.verdict}`} values={{ score: k.score !== null ? intl.formatNumber(k.score, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '' }} />
                </span>
                <span className={styles.muted}>
                  <FormattedMessage id="characters.page.checkMeta" values={{ n: k.version, date: date(k.createdAt) }} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>
            <FormattedMessage id="characters.page.noChecks" />
          </p>
        )}
        <p className={styles.muted}>
          <FormattedMessage id="characters.page.checksHint" />
        </p>
      </section>

      {!c.training.available ? (
        <p className={styles.muted} data-testid="character-training">
          <FormattedMessage id="characters.page.trainingUnavailable" />
        </p>
      ) : null}
    </div>
  );
}
