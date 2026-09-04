// src/lib/supabaseAdmin.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// 💡 特権キー（Service Role Key）を読み込む
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// このクライアントを使って操作すると、RLSを完全にバイパス（突破）できます
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});