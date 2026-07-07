import type { SourceConnector, SourceObjectDescriptor, SourceRecord, SourceRecordBatch } from './types.ts';
import { AppSheetVehicleConnector } from './appsheet-vehicles.ts';

const vehicleRecords: SourceRecord[] = [
  {
    external_id: 'veh-001',
    source_updated_at: '2026-06-20T10:00:00+05:00',
    data: {
      id: 'veh-001', code: 'A-001', name: 'Toyota Hilux A001', type: 'vehicle', vehicle_class: 'pickup',
      plate: '001AAA02', model: 'Toyota Hilux', year: 2021, status: 'active', is_group: false,
      parent_id: null, location_id: 'facility-almaty-yard', responsible_person_id: 'emp-001', updated_at: '2026-06-20T10:00:00+05:00',
    },
  },
  {
    external_id: 'veh-002',
    source_updated_at: '2026-06-21T11:00:00+05:00',
    data: {
      id: 'veh-002', code: 'A-002', name: 'Hyundai Porter A002', type: 'vehicle', vehicle_class: 'truck',
      plate: '002AAA02', model: 'Hyundai Porter', year: 2020, status: 'repair', is_group: false,
      parent_id: null, location_id: 'facility-almaty-yard', responsible_person_id: 'emp-002', updated_at: '2026-06-21T11:00:00+05:00',
    },
  },
  {
    external_id: 'veh-folder',
    source_updated_at: '2026-06-01T00:00:00+05:00',
    data: { id: 'veh-folder', code: 'VEH', name: 'Vehicles folder', type: 'folder', node_type: 'folder', is_group: true, parent_id: null, updated_at: '2026-06-01T00:00:00+05:00' },
  },
];

const equipmentRecords: SourceRecord[] = [
  ...vehicleRecords,
  { external_id: 'eq-101', source_updated_at: '2026-06-15T09:30:00+05:00', data: { id: 'eq-101', code: 'PUMP-101', name: 'Pump 101', type: 'pump', is_group: false, parent_id: 'eq-line-1', location_id: 'facility-prod-1', updated_at: '2026-06-15T09:30:00+05:00' } },
];

const peopleRecords: SourceRecord[] = [
  { external_id: 'emp-001', source_updated_at: '2026-06-10T12:00:00+05:00', data: { id: 'emp-001', full_name: 'Example Person One', department_id: 'dep-ops', position_id: 'pos-driver', iin: '000000000000', updated_at: '2026-06-10T12:00:00+05:00' } },
  { external_id: 'emp-002', source_updated_at: '2026-06-11T12:00:00+05:00', data: { id: 'emp-002', full_name: 'Example Person Two', department_id: 'dep-ops', position_id: 'pos-mechanic', updated_at: '2026-06-11T12:00:00+05:00' } },
];

const measurementActRecords: SourceRecord[] = [
  { external_id: 'act-001', source_updated_at: '2026-06-22T09:00:00+05:00', data: { id: 'act-001', vehicle_id: 'veh-001', status: 'active', kind: 'inspection', updated_at: '2026-06-22T09:00:00+05:00' } },
  { external_id: 'act-002', source_updated_at: '2026-06-23T09:00:00+05:00', data: { id: 'act-002', vehicle_id: 'veh-001', status: 'active', kind: 'repair', updated_at: '2026-06-23T09:00:00+05:00' } },
  { external_id: 'act-003', source_updated_at: '2026-06-24T09:00:00+05:00', data: { id: 'act-003', vehicle_id: 'veh-002', status: 'cancelled', kind: 'inspection', updated_at: '2026-06-24T09:00:00+05:00' } },
];

const recordsByObject: Record<string, SourceRecord[]> = {
  vehicle: vehicleRecords,
  equipment: equipmentRecords,
  people: peopleRecords,
  measurement_acts: measurementActRecords,
};

export class FakeSourceConnector implements SourceConnector {
  id = 'fake-source';
  displayName = 'Fake Source Connector';

  async listObjects(): Promise<SourceObjectDescriptor[]> {
    return [
      { name: 'vehicle', displayName: 'Vehicles', estimatedCount: vehicleRecords.length, supportsChangedSince: true },
      { name: 'equipment', displayName: 'Equipment', estimatedCount: equipmentRecords.length, supportsChangedSince: true },
      { name: 'people', displayName: 'People', estimatedCount: peopleRecords.length, supportsChangedSince: true },
      { name: 'measurement_acts', displayName: 'Measurement Acts', estimatedCount: measurementActRecords.length, supportsChangedSince: true },
    ];
  }

  async sample(objectName: string, limit: number): Promise<SourceRecord[]> {
    return (recordsByObject[objectName] || []).slice(0, Math.max(0, limit));
  }

  async *fetchAll(objectName: string, cursor?: string): AsyncIterable<SourceRecordBatch> {
    const rows = recordsByObject[objectName] || [];
    const start = cursor ? Number(cursor) || 0 : 0;
    const batch = rows.slice(start, start + 50);
    yield { records: batch, cursor: start + batch.length < rows.length ? String(start + batch.length) : null };
  }

  async *fetchChangedSince(objectName: string, since: string): AsyncIterable<SourceRecordBatch> {
    const t = Date.parse(since);
    const rows = (recordsByObject[objectName] || []).filter(r => r.source_updated_at && Date.parse(r.source_updated_at) > t);
    yield { records: rows, cursor: null };
  }

  async fetchById(objectName: string, id: string): Promise<SourceRecord | null> {
    return (recordsByObject[objectName] || []).find(r => r.external_id === id) || null;
  }
}

export function getSourceConnector(id: string, config?: Record<string, unknown>): SourceConnector | null {
  if (id === 'fake-source' || id === 'fake') return new FakeSourceConnector();
  if (id === 'appsheet-vehicles' || id === 'appsheet' || id.startsWith('appsheet-')) return new AppSheetVehicleConnector({
    connectorId: id,
    appId: typeof config?.app_id === 'string' ? config.app_id : (typeof config?.appId === 'string' ? config.appId : undefined),
    accessKey: typeof config?.access_key === 'string' ? config.access_key : (typeof config?.accessKey === 'string' ? config.accessKey : undefined),
    tableName: typeof config?.table_name === 'string' ? config.table_name : undefined,
    primaryKeyField: typeof config?.primary_key_field === 'string' ? config.primary_key_field : undefined,
    updatedAtField: typeof config?.updated_at_field === 'string' ? config.updated_at_field : undefined,
    baseUrl: typeof config?.base_url === 'string' ? config.base_url : undefined,
  });
  return null;
}
