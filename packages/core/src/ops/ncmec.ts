/**
 * NCMEC CyberTipline report packet (D-027). A prefilled, structured summary
 * for the human who submits the report through the CyberTipline (never sent
 * automatically). Field names follow the CyberTipline reporting categories:
 * reporter, incident, reported person, uploaded files. Values the system does
 * not know stay `null` for the submitter to fill in; owner-only facts (the ESP
 * registration and legal contact) are placeholders until set.
 */
export interface EvidenceRef {
  id: string;
  kind: 'object' | 'text';
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  capturedAt: number;
}

export interface NcmecPacketInput {
  caseId: string;
  createdAt: number;
  /** How the content came to our attention. */
  source: 'automated_check' | 'user_report' | 'staff';
  stage: string | null;
  codes: string[];
  appUrl: string;
  incidentAt: number;
  reportedUser: { id: string | null; email: string | null; name: string | null; createdAt: string | null; workspaceId: string | null };
  /** Where the content was (share link, run id) when known. */
  location: { runId: string | null; jobId: string | null; shareUrl: string | null };
  evidence: EvidenceRef[];
}

export interface NcmecPacket {
  version: 1;
  generatedAt: number;
  submission: { status: 'pending'; instructions: string; url: string };
  reporter: { companyName: string; espId: string; contactName: string; contactEmail: string };
  incident: {
    type: 'apparent_child_pornography';
    incidentDateTime: string;
    detection: string;
    internalCaseId: string;
    platformArea: string;
    location: NcmecPacketInput['location'];
  };
  reportedPerson: {
    espUserId: string | null;
    email: string | null;
    screenName: string | null;
    accountCreated: string | null;
    workspaceId: string | null;
    ipAddresses: null;
  };
  uploadedFiles: { evidenceId: string; fileType: 'file' | 'text'; contentType: string | null; sha256: string | null; size: number | null; capturedAt: string; viewedByEsp: false; publiclyAvailable: false }[];
  notes: string;
}

const DETECTION: Record<NcmecPacketInput['source'], string> = {
  automated_check: 'Automated pre- or post-generation safety check (hard limit MINOR_SEXUAL)',
  user_report: 'User report confirmed by a reviewer',
  staff: 'Found by staff',
};

export function buildNcmecPacket(input: NcmecPacketInput, now: number): NcmecPacket {
  return {
    version: 1,
    generatedAt: now,
    submission: {
      status: 'pending',
      instructions:
        'A trained reviewer submits this report by hand through the CyberTipline (ESP reporting). Do not view the evidence files unless required. Attach files only from the locked evidence prefix. Record the report number here when done.',
      url: 'https://report.cybertip.org/',
    },
    reporter: { companyName: '[COMPANY LEGAL NAME]', espId: '[NCMEC ESP ID]', contactName: '[T&S CONTACT]', contactEmail: 'abuse@rolling.actor' },
    incident: {
      type: 'apparent_child_pornography',
      incidentDateTime: new Date(input.incidentAt).toISOString(),
      detection: `${DETECTION[input.source]}${input.stage ? ` at stage ${input.stage}` : ''}${input.codes.length ? ` (${input.codes.join(', ')})` : ''}`,
      internalCaseId: input.caseId,
      platformArea: input.location.shareUrl ? 'Public share link' : 'Generation request',
      location: input.location,
    },
    reportedPerson: {
      espUserId: input.reportedUser.id,
      email: input.reportedUser.email,
      screenName: input.reportedUser.name,
      accountCreated: input.reportedUser.createdAt,
      workspaceId: input.reportedUser.workspaceId,
      ipAddresses: null,
    },
    uploadedFiles: input.evidence.map((e) => ({
      evidenceId: e.id,
      fileType: e.kind === 'object' ? 'file' : 'text',
      contentType: e.contentType,
      sha256: e.sha256,
      size: e.size,
      capturedAt: new Date(e.capturedAt).toISOString(),
      viewedByEsp: false,
      publiclyAvailable: false,
    })),
    notes: `Evidence is preserved in the locked private prefix for case ${input.caseId} (docs/trust-safety.md). Generated content was blocked before delivery unless the location shows a share link.`,
  };
}

/** 18 U.S.C. 2258A(h) as amended (REPORT Act, 2024): preserve for one year after the report. */
export const EVIDENCE_RETENTION_DAYS = 365;
