import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Combobox, MultiCombobox } from '../../components/Combobox';
import { PhotoPicker } from '../../components/PhotoPicker';
import { Field, PageHeader, Spinner } from '../../components/ui';
import { useCard, useCollections, usePhotoQuality } from '../../data/hooks';
import { invalidatePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import { db } from '../../data/db';
import { todayIso } from '../../lib/id';
import { CURRENCIES } from '../../lib/format';
import type { Card } from '../../data/types';

interface FormState {
  name: string;
  acquiredAt: string;
  groupId?: string;
  memberIds: string[];
  albumId?: string;
  sourceId?: string;
  cardTypeId?: string;
  statusId?: string;
  price: string;
  currency: string;
  note: string;
  frontPhotoId?: string;
  backPhotoId?: string;
  folderIds: string[];
}

const blankForm = (): FormState => ({
  name: '',
  acquiredAt: todayIso(),
  memberIds: [],
  price: '',
  currency: 'TWD',
  note: '',
  folderIds: [],
});

const fromCard = (card: Card): FormState => ({
  name: card.name,
  acquiredAt: card.acquiredAt,
  groupId: card.groupId,
  memberIds: [...card.memberIds],
  albumId: card.albumId,
  sourceId: card.sourceId,
  cardTypeId: card.cardTypeId,
  statusId: card.statusId,
  price: card.price == null ? '' : String(card.price),
  currency: card.currency ?? 'TWD',
  note: card.note ?? '',
  frontPhotoId: card.frontPhotoId,
  backPhotoId: card.backPhotoId,
  folderIds: [...card.folderIds],
});

export default function CardFormPage() {
  const { cardId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = !!cardId;

  const existing = useCard(cardId);
  const collections = useCollections();
  const quality = usePhotoQuality();

  const [form, setForm] = useState<FormState>(blankForm);
  const [ready, setReady] = useState(!isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Photos are written to IndexedDB the moment they are picked, so anything
  // picked but not saved has to be swept up — otherwise abandoning the form
  // leaks megabytes of orphaned blobs.
  const staged = useRef<Set<string>>(new Set());
  const savedRef = useRef(false);

  // Pre-fill from the query string when arriving from a 套卡 slot or a group page.
  useEffect(() => {
    if (isEdit || ready) return;
    const preset: Partial<FormState> = {};
    const groupId = searchParams.get('group');
    const memberId = searchParams.get('member');
    const folderId = searchParams.get('folder');
    if (groupId) preset.groupId = groupId;
    if (memberId) preset.memberIds = [memberId];
    if (folderId) preset.folderIds = [folderId];
    if (Object.keys(preset).length) setForm((f) => ({ ...f, ...preset }));
    setReady(true);
  }, [isEdit, ready, searchParams]);

  useEffect(() => {
    if (!isEdit || ready) return;
    if (existing === undefined) return; // still loading
    if (existing === null) {
      navigate('/', { replace: true });
      return;
    }
    setForm(fromCard(existing));
    setReady(true);
  }, [isEdit, ready, existing, navigate]);

  useEffect(
    () => () => {
      if (savedRef.current) return;
      // Unmounted without saving — drop every photo this session created.
      for (const id of staged.current) {
        invalidatePhotoUrl(id);
        void db.photos.delete(id);
      }
    },
    [],
  );

  const memberOptions = useMemo(() => {
    if (!collections) return [];
    const inGroup = form.groupId
      ? collections.members.filter((m) => m.groupId === form.groupId)
      : [];
    return inGroup.map((m) => ({ id: m.id, label: m.name }));
  }, [collections, form.groupId]);

  if (!collections || !ready) return <Spinner />;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setPhoto = (slot: 'frontPhotoId' | 'backPhotoId') => (photoId: string | undefined) => {
    if (photoId) staged.current.add(photoId);
    set(slot, photoId);
  };

  const toOptions = (rows: { id: string; name: string }[]) =>
    rows.map((r) => ({ id: r.id, label: r.name }));

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      setError('請輸入小卡名稱');
      return;
    }
    if (!form.acquiredAt) {
      setError('請選擇收藏時間');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const parsed = form.price.trim() === '' ? undefined : Number(form.price);
      const price = parsed != null && Number.isFinite(parsed) ? parsed : undefined;
      const payload = {
        name,
        acquiredAt: form.acquiredAt,
        groupId: form.groupId,
        memberIds: form.memberIds,
        albumId: form.albumId,
        sourceId: form.sourceId,
        cardTypeId: form.cardTypeId,
        statusId: form.statusId,
        price,
        currency: price == null ? undefined : form.currency,
        note: form.note.trim() || undefined,
        frontPhotoId: form.frontPhotoId,
        backPhotoId: form.backPhotoId,
        folderIds: form.folderIds,
      };

      let targetId: string;
      if (isEdit && existing) {
        await repo.cards.update(existing.id, payload);
        targetId = existing.id;
        // Photos the edit replaced are now unreferenced.
        for (const previous of [existing.frontPhotoId, existing.backPhotoId]) {
          if (previous && previous !== payload.frontPhotoId && previous !== payload.backPhotoId) {
            invalidatePhotoUrl(previous);
            await repo.photos.removeIfOrphaned(previous);
          }
        }
      } else {
        const created = await repo.cards.create({ ...payload, setId: undefined, setSlotId: undefined });
        targetId = created.id;
      }

      // Anything picked mid-session and then swapped out never made it in.
      for (const id of staged.current) {
        if (id !== payload.frontPhotoId && id !== payload.backPhotoId) {
          invalidatePhotoUrl(id);
          await db.photos.delete(id);
        }
      }
      savedRef.current = true;

      const slotSetId = searchParams.get('set');
      const slotId = searchParams.get('slot');
      if (slotSetId && slotId) {
        await repo.cards.assignToSlot(targetId, slotSetId, slotId);
        navigate(`/sets/${slotSetId}`, { replace: true });
      } else {
        navigate(`/cards/${targetId}`, { replace: true });
      }
    } catch (e) {
      console.error(e);
      setError('儲存失敗，請再試一次');
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PageHeader
        title={isEdit ? '編輯小卡' : '新增小卡'}
        back
        actions={
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? '儲存中…' : '儲存'}
          </button>
        }
      />

      <div className="grid gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3 md:gap-4">
          <PhotoPicker
            label="正面"
            photoId={form.frontPhotoId}
            quality={quality}
            onChange={setPhoto('frontPhotoId')}
          />
          <PhotoPicker
            label="背面"
            photoId={form.backPhotoId}
            quality={quality}
            onChange={setPhoto('backPhotoId')}
          />
        </div>

        <div className="flex flex-col gap-4">
          <Field label="名稱">
            <input
              className="field"
              placeholder="例如：LOVE DIVE 特典 — 張員瑛"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Combobox
              label="團體"
              value={form.groupId}
              options={toOptions(collections.groups)}
              onChange={(id) =>
                // Members belong to a group; changing it invalidates the picks.
                setForm((f) => ({ ...f, groupId: id, memberIds: [] }))
              }
              onCreate={async (name) => (await repo.groups.ensure(name)).id}
            />

            <MultiCombobox
              label="成員"
              values={form.memberIds}
              options={memberOptions}
              disabled={!form.groupId}
              disabledHint="請先選擇團體"
              onChange={(ids) => set('memberIds', ids)}
              onCreate={
                form.groupId
                  ? async (name) => (await repo.members.ensureInGroup(form.groupId!, name)).id
                  : undefined
              }
            />

            <Combobox
              label="專輯／活動出處"
              value={form.albumId}
              options={toOptions(collections.albums)}
              onChange={(id) => set('albumId', id)}
              onCreate={async (name) =>
                (await repo.albums.ensure(name, { groupId: form.groupId })).id
              }
            />

            <Combobox
              label="來源"
              value={form.sourceId}
              options={toOptions(collections.sources)}
              onChange={(id) => set('sourceId', id)}
              onCreate={async (name) => (await repo.sources.ensure(name)).id}
            />

            <Combobox
              label="卡種"
              value={form.cardTypeId}
              options={toOptions(collections.cardTypes)}
              onChange={(id) => set('cardTypeId', id)}
              onCreate={async (name) => (await repo.cardTypes.ensure(name)).id}
            />

            <Combobox
              label="持有狀態"
              value={form.statusId}
              options={toOptions(collections.statuses)}
              onChange={(id) => set('statusId', id)}
              onCreate={async (name) => (await repo.statuses.ensure(name)).id}
            />

            <Field label="收藏時間">
              <input
                type="date"
                className="field"
                value={form.acquiredAt}
                onChange={(e) => set('acquiredAt', e.target.value)}
                required
              />
            </Field>

            <Field label="取得價格">
              <div className="flex gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  className="field"
                  placeholder="選填"
                  value={form.price}
                  onChange={(e) => set('price', e.target.value)}
                />
                <select
                  className="field w-24 shrink-0"
                  value={form.currency}
                  onChange={(e) => set('currency', e.target.value)}
                  aria-label="幣別"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>

          <MultiCombobox
            label="收藏夾"
            values={form.folderIds}
            options={toOptions(collections.folders)}
            onChange={(ids) => set('folderIds', ids)}
            onCreate={async (name) => (await repo.folders.ensure(name)).id}
          />

          <Field label="備註">
            <textarea
              className="field min-h-24 resize-y"
              placeholder="換卡對象、保存狀況、其他想記的事…"
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
            />
          </Field>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1" disabled={saving}>
              {saving ? '儲存中…' : '儲存'}
            </button>
            <button type="button" className="btn-outline" onClick={() => navigate(-1)}>
              取消
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
