// src/app/api/analyze/route.ts
export const dynamic = 'force-dynamic';

import { google } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 1. AIに返してほしいデータの構造（スキーマ）を定義
// これを定義することで、AIが必ずこの通りのJSONを返してくるようになります（超重要！）
const receiptSchema = z.object({
    date: z.string().describe('レシートの日付 (YYYY-MM-DD形式)'),
    totalAmount: z.number().describe('合計金額 (税込)'),
    shopName: z.string().describe('店舗名'),
    items: z.array(
        z.object({
            name: z.string().describe('品目名・商品名'),
            price: z.number().describe('単価'),
            category: z.string().describe('食費、日用品、交際費、衣服、その他 などのカテゴリ分類'),
        })
    ).describe('購入した商品のリスト'),
});

export async function POST(req: Request) {
    try {
        // 2. フロントエンドから送られてきた FormData を取得（PHPの $_FILES や $_POST のようなもの）
        const formData = await req.formData();
        const file = formData.get('image') as File | null;

        // フロントエンドから送られてきた ユーザーID を取得
        const userId = formData.get('userId') as string | null;

        if (!file) {
            return NextResponse.json({ error: '画像ファイルがありません。' }, { status: 400 });
        }
        if (!userId) {
            return NextResponse.json({ error: 'ログインユーザー情報がありません。' }, { status: 401 });
        }

        // 3. 画像ファイルをAIが読み込めるバイナリ形式（Buffer / Base64）に変換
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // 4. Vercel AI SDK を使って Gemini API を呼び出し、画像を解析
        const { output: receiptData } = await generateText({
            model: google('gemini-2.5-flash'), // 高速かつ画像認識が得意な無料枠のあるモデル
            output: Output.object({ schema: receiptSchema }),
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '添付されたレシートの画像を解析し、店舗名、日付、合計金額、品目リストを抽出してください。商品ごとに最適な家計簿カテゴリも推測して分類してください。',
                        },
                        {
                            type: 'image',
                            image: buffer,
                        },
                    ],
                },
            ],
        });

        // 解析データが空などの異常系チェック
        if (!receiptData) throw new Error('AIの解析結果が空です');

        // 2. Supabaseへのデータ保存処理
        // (A) まずは親テーブル（receipts）に保存
        // `.select().single()` をつけることで、今インサートされたレコード（発行されたIDなど）を即座に取得できます
        const { data: insertedReceipt, error: receiptError } = await supabaseAdmin
            .from('receipts')
            .insert({
                shop_name: receiptData.shopName,
                purchase_date: receiptData.date,
                total_amount: receiptData.totalAmount,
                user_id: userId,
            })
            .select()
            .single();

        if (receiptError) throw receiptError;

        // (B) 子テーブル（receipt_items）に保存するためのデータ配列を組み立て
        // 全ての商品に、今発行されたばかりの「親レシートのID（insertedReceipt.id）」を紐付けます
        const itemsToInsert = receiptData.items.map((item) => ({
            receipt_id: insertedReceipt.id, // 親との紐付け（インポータント！）
            name: item.name,
            price: item.price,
            category: item.category,
        }));

        // 子テーブルに一括挿入（バルクインサート）
        const { error: itemsError } = await supabaseAdmin
            .from('receipt_items')
            .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        // 3. 最後にフロントエンドにはAIの解析結果（または保存されたデータ）を返す
        return NextResponse.json(receiptData);

    } catch (error) {
        // もしこれでもエラーが出る場合、原因を特定しやすくするために error 全体をログに出します
        console.error('AI解析またはDB保存エラー:', error);
        return NextResponse.json({ error: '処理に失敗しました。' }, { status: 500 });
    }
}