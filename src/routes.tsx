import { Navigate, type RouteObject } from 'react-router-dom';
import CardWallPage from './features/cards/CardWallPage';
import CardFormPage from './features/cards/CardFormPage';
import CardDetailPage from './features/cards/CardDetailPage';
import GroupsPage from './features/groups/GroupsPage';
import GroupDetailPage from './features/groups/GroupDetailPage';
import MemberPage from './features/groups/MemberPage';
import FoldersPage from './features/folders/FoldersPage';
import FolderDetailPage from './features/folders/FolderDetailPage';
import SetsPage from './features/sets/SetsPage';
import SetDetailPage from './features/sets/SetDetailPage';
import SettingsPage from './features/settings/SettingsPage';

export const routes: RouteObject[] = [
  { index: true, element: <CardWallPage /> },

  // `/cards/new` must be declared before `/cards/:cardId` so "new" is not
  // swallowed as an id.
  { path: 'cards/new', element: <CardFormPage /> },
  { path: 'cards/:cardId', element: <CardDetailPage /> },
  { path: 'cards/:cardId/edit', element: <CardFormPage /> },

  { path: 'groups', element: <GroupsPage /> },
  { path: 'groups/:groupId', element: <GroupDetailPage /> },
  { path: 'members/:memberId', element: <MemberPage /> },

  { path: 'folders', element: <FoldersPage /> },
  { path: 'folders/:folderId', element: <FolderDetailPage /> },

  { path: 'sets', element: <SetsPage /> },
  { path: 'sets/:setId', element: <SetDetailPage /> },

  { path: 'settings', element: <SettingsPage /> },

  { path: '*', element: <Navigate to="/" replace /> },
];
