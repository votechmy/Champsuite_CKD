import { UploadForm } from './upload-form';

export const dynamic = 'force-dynamic';

export default function UploadPage() {
  return (
    <div>
      <h1>Upload Riftbound inventory</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: 24 }}>
        Drop the TSV file from your magic sorter. Each scanned card becomes one row in{' '}
        <code>riftbound_inventory</code>, joined to the Riftcodex catalog by set + collector number.
        Existing rows (by <code>uuid</code>) are updated; nothing is deleted.
      </p>

      <UploadForm />

      <div style={{ marginTop: 32, fontSize: 13 }} className="muted">
        <strong>Expected columns (tab-separated, header row required):</strong>
        <pre style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: 12,
          marginTop: 8,
          fontSize: 12,
          overflow: 'auto',
        }}>
{`set  rarity  lang  title  local_title  collector_num  condition  foil
position  height  price  price_trend  ecommerce_id  scryfall_id  uuid  confidence`}
        </pre>
        Required: <code>set</code>, <code>collector_num</code>, <code>uuid</code> (must be a valid UUID).
        All other columns are optional.
      </div>
    </div>
  );
}
