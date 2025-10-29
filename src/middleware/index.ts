import { defineMiddleware } from 'astro:middleware';

import { supabaseClient } from '../db/supabase.client';

export const onRequest = defineMiddleware((context, next) => {
  // Attach typed supabase client to locals
  context.locals.supabase = supabaseClient;
  return next();
});
