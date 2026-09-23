/** en — every surface, merged. */
import { apikeys } from './apikeys';
import { attention } from './attention';
import { audit } from './audit';
import { categories } from './categories';
import { chrome } from './chrome';
import { common } from './common';
import { customers } from './customers';
import { dashboard } from './dashboard';
import { editor } from './editor';
import { header } from './header';
import { language } from './language';
import { media } from './media';
import { messages } from './messages';
import { nav } from './nav';
import { palette } from './palette';
import { orders } from './orders';
import { plugins } from './plugins';
import { posts } from './posts';
import { profile } from './profile';
import { themes } from './themes';
import { tools } from './tools';
import { users } from './users';
import { webhooks } from './webhooks';

import type { Catalogue } from '../../lib/i18n/translate';

export const en: Catalogue = {
  ...apikeys,
  ...attention,
  ...audit,
  ...categories,
  ...chrome,
  ...common,
  ...customers,
  ...dashboard,
  ...editor,
  ...header,
  ...language,
  ...media,
  ...messages,
  ...nav,
  ...palette,
  ...orders,
  ...plugins,
  ...posts,
  ...profile,
  ...themes,
  ...tools,
  ...users,
  ...webhooks,
};

export default en;
