/**
 * Download of a result (`GET /api/runs/:id/download` → signed media URL,
 * D-008). The mock saves a small text file describing the result so the
 * browser's download flow runs for real.
 */
export function downloadMock(id: string, prompt: string, video: boolean) {
  const blob = new Blob([`Rolling result ${id}\n${video ? 'Video' : 'Image'}\n${prompt}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rolling-${id}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
