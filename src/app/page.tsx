// src/app/page.tsx
'use client'; // ブラウザ側で動くコンポーネント（React Hooksを使う場合）であることを宣言
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image'
import { supabase } from '../lib/supabase';
// Recharts グラフ用
import { PieChart, Pie, Tooltip, Legend, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
// ログイン機能用
import { User } from '@supabase/supabase-js';

// 1. TypeScriptの型定義（APIから返ってくるJSONの構造を定義）
// 定義することでエラーを検知しバグを未然に防ぐ
// レシート内の1商品
interface ReceiptItem {
    name: string;
    price: number;
    category: string;
}
// レシート1件分のデータ（合計金額・店舗名・品目リスト）
interface ReceiptData {
    date: string;
    totalAmount: number;
    shopName: string;
    items: ReceiptItem[];
}

// 店舗ごとの購入品を保持する用
interface ReceiptGroup {
    shop_name: string;
    total_amount: number;
    receipt_items: ReceiptItem[];
}

// 同日のデータをまとめる用（中に複数のレシートを保持）
interface DailyHistory {
    purchase_date: string;
    total_amount: number; // その日の全店舗の合計金額
    receipts: ReceiptGroup[]; // その日のレシートリスト
}
// 月別履歴用
interface MonthlyHistory {
    month: string; // "2026年06月"
    days: DailyHistory[];
}

// グラフのデータ型
interface ChartData {
    name: string;
    value: number;
    fill: string;
}

// カテゴリごとの色
const COLORS: Record<string, string> = {
    食費: '#ff8800',
    酒代: '#ff0015',
    園芸: '#10B981',
    ペット: '#ff3b9d',
    日用品: '#3babf6',
    交際費: '#f5de0b',
    服飾: '#be1ae7',
    その他: '#9ca3af',
};

export default function Home() {
    // 状態定義（状態が変わると該当部分だけが自動で再描画）
    // ↓ [現在の状態, その状態を更新するための関数]
    const [user, setUser] = useState<User | null>(null);
    // ログインか新規登録かの切り替え
    const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
    const [authError, setAuthError] = useState<string | null>(null);
    const [authMessage, setAuthMessage] = useState<string | null>(null);

    // 入力モード切り替えタブ用 ('ai' または 'manual')
    const [inputTab, setInputTab] = useState<'ai' | 'manual'>('ai');

    // 手動入力用
    const [manualDate, setManualDate] = useState(new Date().toISOString().split('T')[0]);
    const [manualShop, setManualShop] = useState('');
    const [manualItems, setManualItems] = useState<ReceiptItem[]>([{ name: '', price: 0, category: '酒代' }]);

    // カレンダー表示用
    const [currentDate, setCurrentDate] = useState(new Date());
    const [selectedDayData, setSelectedDayData] = useState<DailyHistory | null>(null);

    // 家計簿用
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<ReceiptData | null>(null);
    const [error, setError] = useState<string | null>(null);

    // 今月の円グラフ用
    const [pieChartData, setPieChartData] = useState<ChartData[]>([]);
    const [lineChartData, setLineChartData] = useState<{ name: string; 支出: number }[]>([]); // 月ごと推移用
    const [monthlyHistory, setMonthlyHistory] = useState<MonthlyHistory[]>([]); // 過去の履歴用

    // 予算データ用の状態（例: { "2026年06月": 50000, "2026年07月": 60000 }）
    const [budgets, setBudgets] = useState<Record<string, number>>({});

    // 画面更新用
    const [refreshCounter, setRefreshCounter] = useState(0);

    // 今表示しているカレンダーの月の文字列 (例: "2026年06月")
    const currentMonthKey = `${currentDate.getFullYear()}年${String(currentDate.getMonth() + 1).padStart(2, '0')}月`;

    // 実際の「現在の月」と「来月の月」の文字列を生成
    const today = new Date();
    const actualCurrentMonthKey = `${today.getFullYear()}年${String(today.getMonth() + 1).padStart(2, '0')}月`;
    const nextMonthDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthKey = `${nextMonthDate.getFullYear()}年${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}月`;

    // ログイン状態監視
    useEffect(() => {
        // 現在ログインしているユーザーがいれば取得
        supabase.auth.getUser().then(({ data: { user } }) => {
            setUser(user);
        });

        // ログイン・ログアウトのイベントを監視
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setUser(session?.user ?? null); // ??左辺(user)がnullなら右辺を返す
        });

        return () => subscription.unsubscribe();
    }, []);

    // すべてのデータをSupabaseから取得して各種整形する関数
    const loadAllData = useCallback(async () => {
        if (!user) return; // ログインしていなければ終了

        try {
            // 1. 過去のレシート履歴を全件取得（日付が新しい順）
            const { data: receiptsData, error: rError } = await supabase
                .from('receipts')
                .select(`
                        id,
                        shop_name,
                        purchase_date,
                        total_amount,
                        receipt_items (
                            name,
                            price,
                            category
                        )
                    `)
                .order('purchase_date', { ascending: false });
            if (rError) throw rError;

            // 2. 履歴データの整形（日別・月別）
            if (receiptsData) {
                // 日ごと r→ﾚｼ-ﾄのr
                const dailyMap: { [date: string]: DailyHistory } = {};
                receiptsData.forEach((r) => {
                    const date = r.purchase_date;
                    const items = (r.receipt_items as unknown as ReceiptItem[]) || [];

                    // このレシート単体のデータを作る
                    const currentReceipt: ReceiptGroup = {
                        shop_name: r.shop_name,
                        total_amount: r.total_amount,
                        receipt_items: items
                    };

                    if (!dailyMap[date]) {
                        // その日付のデータが初登場なら新しく作成
                        dailyMap[date] = {
                            purchase_date: date,
                            total_amount: r.total_amount,
                            receipts: [currentReceipt]
                        };
                    } else {
                        // すでに同じ日付があれば、その日の合計金額を加算し、レシート配列に追加
                        dailyMap[date].total_amount += r.total_amount;
                        dailyMap[date].receipts.push(currentReceipt);
                    }
                });

                // 月単位 a/b比較し新しい順に並び替え Object.keys()←keyの配列を返す
                const sortedDates = Object.keys(dailyMap).sort((a, b) => b.localeCompare(a));
                const monthlyMap: { [month: string]: DailyHistory[] } = {};
                const monthOrder: string[] = [];

                sortedDates.forEach((date) => {
                    // 例: "2026-07-02" から最初の7文字 "2026-07" を切り出し、"2026年07月" に変換
                    const month = date.substring(0, 7).replace('-', '年') + '月';
                    if (!monthlyMap[month]) {
                        monthlyMap[month] = [];
                        monthOrder.push(month);
                    }
                    monthlyMap[month].push(dailyMap[date]);
                });
                const formattedMonthlyHistory = monthOrder.map((month) => ({
                    month,
                    days: monthlyMap[month]
                }));
                setMonthlyHistory(formattedMonthlyHistory);

                // カレンダーで現在選択中の日のデータも最新化する
                if (selectedDayData) {
                    setSelectedDayData(dailyMap[selectedDayData.purchase_date] || null);
                }
            }

            // 3. 折れ線グラフ用データ整形（acc は accumulate の略）
            if (receiptsData) {
                // 日付（YYYY-MM-DD）から YYYY年MM月 の形にして集計  reduce()配列の要素を単一の値にまとめる
                const monthlyAggregated = receiptsData.reduce((acc: { [key: string]: number }, r) => {
                    // 上と同じ月文字列への変換
                    const month = r.purchase_date.substring(0, 7).replace('-', '年') + '月';
                    acc[month] = (acc[month] || 0) + r.total_amount;
                    return acc;
                }, {});
                // 古い月>新しい月の順に並び替え
                const formattedLineData = Object.keys(monthlyAggregated).map((key) => ({
                    name: key,
                    支出: monthlyAggregated[key],
                })).reverse();
                setLineChartData(formattedLineData);
            }

            // 円グラフ用データの取得（表示中のカレンダーの月に合わせる）
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth() + 1;
            const formatZero = (num: number) => String(num).padStart(2, '0');
            const startOfMonth = `${year}-${formatZero(month)}-01`;
            const lastDay = new Date(year, month, 0).getDate();
            const endOfMonth = `${year}-${formatZero(month)}-${formatZero(lastDay)}`;
            // 商品リスト
            const { data: itemsData, error: iError } = await supabase
                //.from().select() DBのテーブルからデータを取得
                .from('receipt_items')
                .select(`
                    price,
                    category,
                    receipts!inner(purchase_date)
                `)
                // 今月分だけを絞り込む
                .gte('receipts.purchase_date', startOfMonth) //~以上
                .lte('receipts.purchase_date', endOfMonth); //~以下

            if (iError) throw iError;

            if (itemsData) {
                // itemの型を明示的に指定してエラー回避 aggregate>集計
                const aggregated = itemsData.reduce((acc: { [key: string]: number }, item: { category: string; price: number }) => {
                    const category = item.category || 'その他';
                    acc[category] = (acc[category] || 0) + item.price; //ｶﾃｺﾞﾘ別金額
                    return acc;
                }, {});
                // 円グラフ
                const formattedPieData = Object.keys(aggregated).map((key) => ({
                    name: key, //ｶﾃｺﾞﾘ
                    value: aggregated[key], //額
                    fill: COLORS[key] || COLORS.その他, //色
                }));
                setPieChartData(formattedPieData);
            }

            // 予算データの取得ロジック
            const { data: budgetData, error: bError } = await supabase
                .from('budgets')
                .select('month, amount');
            if (bError) throw bError;

            if (budgetData) { // Record<> 組み込み型
                const budgetMap = budgetData.reduce((acc: Record<string, number>, item) => {
                    acc[item.month] = Number(item.amount);
                    return acc;
                }, {});
                setBudgets(budgetMap);
            }
        } catch (err) {
            console.error('データ取得エラー:', err);
        }
    }, [user, refreshCounter, currentDate]);
    // ログインユーザーが変わったら再取得


    useEffect(() => {
        // ↓のエラーは「偽陽性」無視でok
        // eslint-disable-next-line react-hooks/set-state-in-effect
        loadAllData();
    }, [loadAllData]);

    // ログイン・新規登録の処理
    const handleAuth = async (formData: FormData) => {
        const email = formData.get('email') as string;
        const password = formData.get('password') as string;
        if (!email || !password) return;

        setAuthError(null);
        setAuthMessage(null);

        if (authMode === 'signup') {
            // 新規会員登録 error情報だけ引っ張ってくるｲﾒｰｼﾞ
            // もしsignUpが失敗したらその原因(結果)を変数'error'に代入
            // 分割代入↓成功した場合は空(null)が返る
            const { error } = await supabase.auth.signUp({ email, password });
            if (error) setAuthError(error.message);
            else setAuthMessage('アカウントが作成されました！ログインしてください。');
        } else {
            // ログイン
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) setAuthError(error.message);
        }
    };

    // 簡易(匿名)ログインの処理
    const handleAnonymousSignIn = async () => {
        setAuthError(null);
        setAuthMessage(null);
        setLoading(true);
        try {
            const { error } = await supabase.auth.signInAnonymously();

            if (error) {
                // この時点のerrorは自動的にSupabaseのAuthError型として認識されます
                setAuthError(error.message);
                return;
            }
        } catch (err) {
            // ネットワーク遮断などAPIコールの前段階で発生する予期せぬ例外のケア
            const message = err instanceof Error ? err.message : '簡易ログインに失敗しました。';
            setAuthError(message);
        } finally {
            setLoading(false);
        }
    };


    // フォームが送信された時、引数にブラウザから送信された formData が自動で入ってきます。
    const handleFormAction = async (formData: FormData) => {
        const file = formData.get('image') as File | null;
        if (!file || file.size === 0) return; // ファイルが空なら処理しない
        if (!user) return; // ログインガード

        setLoading(true);
        setError(null);

        try {
            // バックエンドに「誰のレシートか」を伝えるために、ユーザーIDをフォームデータに仕込みます
            formData.append('userId', user.id);

            const response = await fetch('/api/analyze', {
                method: 'POST',
                body: formData,
            });
            if (!response.ok) throw new Error();
            const data: ReceiptData = await response.json();
            setResult(data);
            // 保存が成功したので、グラフデータを再読み込みして画面を同期
            setRefreshCounter((prev) => prev + 1);
        } catch {
            setError('レシートの解析中にエラーが発生しました。');
        } finally {
            setLoading(false);
        }
    };

    // 手動入力の送信ロジック（フロントから直接Supabaseへ）
    const handleManualSubmit = async () => {
        if (!user || !manualShop) return;

        setLoading(true);
        setError(null);

        // 合計金額の自動計算
        const totalAmount = manualItems.reduce((sum, item) => sum + Number(item.price), 0);

        try {
            // 親テーブル（receipts）へ保存
            const { data: insertedReceipt, error: rError } = await supabase
                .from('receipts')
                .insert({
                    shop_name: manualShop,
                    purchase_date: manualDate,
                    total_amount: totalAmount,
                    user_id: user.id
                })
                .select()
                .single();

            if (rError) throw rError;

            // 子テーブル（receipt_items）用のデータ配列組み立て
            const itemsToInsert = manualItems.map((item) => ({
                receipt_id: insertedReceipt.id,
                name: item.name || '未分類商品',
                price: Number(item.price),
                category: item.category
            }));

            const { error: iError } = await supabase.from('receipt_items').insert(itemsToInsert);
            if (iError) throw iError;

            // フォームの初期化
            setManualShop('');
            setManualItems([{ name: '', price: 0, category: '食費' }]);
            alert('支出を手動登録しました！');
            setRefreshCounter((prev) => prev + 1);
        } catch (err) {
            console.error(err);
            setError('手動登録中にエラーが発生しました。');
        } finally {
            setLoading(false);
        }
    };

    // 予算登録用アクションハンドラ（FormDataを直接ハンドリング）
    const handleBudgetSubmit = async (formData: FormData) => {
        if (!user) return;
        const amount = Number(formData.get('budgetAmount'));
        const month = formData.get('budgetMonth') as string;

        if (!amount || !month) return;

        try {
            const { error } = await supabase
                .from('budgets')
                .insert({
                    user_id: user.id,
                    month: month,
                    amount: amount
                });
            if (error) throw error;

            alert(`${month}の予算を登録しました！`);
            setRefreshCounter((prev) => prev + 1);
        } catch (err) {
            console.error(err);
            setError('予算の登録に失敗しました。');
        }
    };

    // 手動入力の品目行を動的に追加・変更・削除する関数群
    const addManualItem = () => {
        setManualItems([...manualItems, { name: '', price: 0, category: '食費' }]);
    };

    const removeManualItem = (index: number) => {
        if (manualItems.length === 1) return;
        setManualItems(manualItems.filter((_, i) => i !== index));
    };

    const updateManualItem = (index: number, key: keyof ReceiptItem, value: string | number) => {
        const newItems = [...manualItems];
        newItems[index] = { ...newItems[index], [key]: value };
        setManualItems(newItems);
    };

    // ファイルが選択されたときの処理+メモリリーク対策
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            // すでに古いプレビューURLがあれば、メモリから消す(解放する)
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            setPreviewUrl(URL.createObjectURL(selectedFile));
            setResult(null);
            setError(null);
        }
    };

    // カレンダー生成ロジック
    const getCalendarDays = () => {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth(); // 0-11
        const firstDayOfWeek = new Date(year, month, 1).getDay(); // 1日の曜日 (0:日 ~ 6:土)
        const daysInMonth = new Date(year, month + 1, 0).getDate(); // 今月の総日数
        const calendarDays: (number | null)[] = [];

        // 1日の曜日までの空マスを埋める
        for (let i = 0; i < firstDayOfWeek; i++) {
            calendarDays.push(null);
        }
        // 1日から末日までを配列に入れる
        for (let i = 1; i <= daysInMonth; i++) {
            calendarDays.push(i);
        }
        return calendarDays;
    };

    const changeMonth = (offset: number) => {
        const newDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1);
        setCurrentDate(newDate);
        setSelectedDayData(null); // 月を変えたら選択をリセット
    };

    // ログインしていない場合はログイン画面を表示
    if (!user) {
        return (
            <main className="max-w-md mx-auto p-6 mt-12 bg-white rounded-lg shadow border border-gray-200 space-y-6">
                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-bold text-gray-800 ">
                        AI家計簿にログイン
                    </h1>
                    <p className="text-xs text-gray-500">
                        レシート画像をアップロードするだけで自動で家計簿を作成します。
                    </p>
                </div>

                {/* 簡易ログインエリア */}
                <div className="space-y-3">
                    <button
                        onClick={handleAnonymousSignIn}
                        disabled={loading}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-md text-sm shadow-sm transition-colors disabled:bg-gray-400"
                    >
                        {loading ? 'ログイン処理中...' : '登録なしで今すぐ始める（簡易ログイン）'}
                    </button>
                    <p className="text-[10px] text-gray-400 text-center leading-relaxed">
                        ※簡易ログイン中はブラウザのキャッシュをクリアするとデータが消失します。<br />後からアカウント登録をすることでデータを引き継げます。
                    </p>
                </div>

                <div className="relative flex py-2 items-center">
                    <div className="flex-grow border-t border-gray-200"></div>
                    <span className="flex-shrink mx-4 text-gray-400 text-xs font-medium">または</span>
                    <div className="flex-grow border-t border-gray-200"></div>
                </div>

                <form action={handleAuth} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
                        <input type="email" name="email" required className="w-full p-2 border rounded-md text-sm" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
                        <input type="password" name="password" required className="w-full p-2 border rounded-md text-sm" />
                    </div>
                    {authError && <div className="p-2 bg-red-50 text-red-700 text-xs rounded">{authError}</div>}
                    {authMessage && <div className="p-2 bg-green-50 text-green-700 text-xs rounded">{authMessage}</div>}

                    <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded-md text-sm">
                        {authMode === 'signin' ? 'ログイン' : '新規アカウント作成'}
                    </button>
                </form>

                <div className="text-center text-xs text-gray-500">
                    {authMode === 'signin' ? (
                        <button onClick={() => setAuthMode('signup')} className="text-blue-600 hover:underline">初めての方はこちら（新規登録）</button>
                    ) : (
                        <button onClick={() => setAuthMode('signin')} className="text-blue-600 hover:underline">すでにアカウントをお持ちの方（ログイン）</button>
                    )}
                </div>
            </main>
        );
    }

    // 今月の合計消費額を計算
    const actualMonthData = monthlyHistory.find(m => m.month === actualCurrentMonthKey);
    const actualMonthTotal = actualMonthData?.days.reduce((sum, d) => sum + d.total_amount, 0) || 0;
    const actualMonthBudget = budgets[actualCurrentMonthKey] || 0;

    // アラートの条件定義
    const isOverBudget = actualMonthBudget > 0 && actualMonthTotal >= actualMonthBudget;
    const isNearBudget = actualMonthBudget > 0 && !isOverBudget && actualMonthTotal >= actualMonthBudget * 0.8;

    // ログインしている場合はダッシュボードを表示
    return (
        <main className="max-w-6xl mx-auto p-6 min-h-screen bg-gray-50 space-y-8">

            <header className="flex flex-col md:flex-row justify-between md:items-center border-b pb-4">
                <h1 className="text-3xl font-bold text-gray-800">AIレシート家計簿ダッシュボード</h1>
                <div className="flex  gap-4 items-center">

                    {/* 簡易ログイン時はメールアドレスが存在しないため表示を出し分け */}
                    <span className="text-xs text-gray-500 font-mono">
                        {user.is_anonymous ? '👤 ゲストユーザー' : user.email}
                    </span>

                    <button onClick={() => supabase.auth.signOut()} className="text-xs bg-gray-200 hover:bg-gray-300 px-3 py-1.5 rounded text-gray-700">
                        ログアウト
                    </button>
                </div>
            </header>

            {/* 予算管理セクション */}
            <div className="bg-white p-6 rounded-lg shadow border border-gray-200 grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* 左側：今月の予算ステータス（アラート機能） */}
                <div className="space-y-3">
                    <h2 className="text-lg font-bold text-gray-800">今月 ({actualCurrentMonthKey}) の予算状況</h2>
                    {actualMonthBudget > 0 ? (
                        <div className="space-y-2">
                            <div className="flex justify-between text-xs font-medium text-gray-600">
                                <span>支出合計: ￥{actualMonthTotal.toLocaleString()}</span>
                                <span>予算枠: ￥{actualMonthBudget.toLocaleString()}</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2.5">
                                <div
                                    className={`h-2.5 rounded-full transition-all duration-300 ${isOverBudget ? 'bg-red-600' : isNearBudget ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${Math.min((actualMonthTotal / actualMonthBudget) * 100, 100)}%` }}
                                ></div>
                            </div>

                            {/* アラート表示 */}
                            {isOverBudget && (
                                <div className="p-3 bg-red-50 text-red-700 text-xs rounded-md font-bold border border-red-200 animate-pulse">
                                    ⚠️ 予算を超過しました！支出を調整しましょう。（引き続き支出登録は可能です）
                                </div>
                            )}
                            {isNearBudget && (
                                <div className="p-3 bg-yellow-50 text-yellow-700 text-xs rounded-md font-bold border border-yellow-200">
                                    ⚠️ 警告：今月の支出が予算の80%を超えました！
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm text-gray-400 italic">今月の予算は設定されていません。</p>
                    )}
                </div>

                {/* 右側：来月の予算設定（登録後は編集不可にする制御） */}
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 flex flex-col justify-center">
                    <h3 className="text-sm font-bold text-gray-700 mb-2">来月 ({nextMonthKey}) の予算設定</h3>
                    {budgets[nextMonthKey] ? (
                        <div>
                            <p className="text-sm text-gray-600">
                                確定予算額: <span className="font-mono font-bold text-gray-900 text-base">￥{budgets[nextMonthKey].toLocaleString()}</span>
                            </p>
                            <span className="text-[10px] text-gray-400 block mt-1">※登録月（今月）の間、来月の予算は編集・再登録できません。</span>
                        </div>
                    ) : (
                        <form action={handleBudgetSubmit} className="flex gap-2 items-center">
                            <input type="hidden" name="budgetMonth" value={nextMonthKey} />
                            <div className="relative flex-1">
                                <span className="absolute left-3 top-2 text-gray-400 text-sm">￥</span>
                                <input
                                    type="number"
                                    name="budgetAmount"
                                    required
                                    min="1"
                                    placeholder="予算額を入力"
                                    className="w-full pl-7 pr-3 py-1.5 border rounded-md text-sm text-gray-700 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                            </div>
                            <button
                                type="submit"
                                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded-md shadow-sm whitespace-nowrap"
                            >
                                予算を確定
                            </button>
                        </form>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* アップロード＆結果 flex-col */}
                <div className="space-y-4">
                    <div className="flex  bg-white p-1 rounded-md border border-gray-200 shadow-sm">
                        <button
                            onClick={() => setInputTab('ai')}
                            className={`flex-1 py-2 text-center text-sm font-medium border-b-2 ${inputTab === 'ai' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                        >
                            AIレシート解析
                        </button>
                        <button
                            onClick={() => setInputTab('manual')}
                            className={`flex-1 py-2 text-center text-sm font-medium border-b-2 ${inputTab === 'manual' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                        >
                            手動で支出入力
                        </button>
                    </div>

                    {/* AI解析フォーム */}
                    {inputTab === 'ai' && (
                        <form action={handleFormAction} className="bg-white p-6 rounded-lg shadow border border-gray-200 space-y-4">
                            <label className="block text-sm font-medium text-gray-700">
                                レシート画像をアップロード
                            </label>
                            <input
                                type="file"
                                name="image" // formDataがこの名前（'image'）でAPIに送られます
                                accept="image/*"
                                onChange={handleFileChange}
                                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                            />
                            {/* 選択された画像のプレビュー表示（URLがあるときだけ表示する条件分岐） */}
                            {previewUrl && (
                                <div className="mt-4 border rounded-lg overflow-hidden max-h-64 flex justify-center bg-gray-100 p-2">
                                    <Image src={previewUrl} alt="Preview" className="object-contain max-h-full"
                                        width={300}
                                        height={300}
                                        unoptimized
                                    />
                                </div>
                            )}
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-md disabled:bg-gray-400"
                            >
                                {loading ? 'AIがレシートを解析中...' : 'レシートを解析する'}
                            </button>
                        </form>
                    )}

                    {/* 手動入力フォーム */}
                    {inputTab === 'manual' && (
                        <form action={handleManualSubmit} className="bg-white p-6 rounded-lg shadow border border-gray-200 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-semibold text-gray-600 mb-1">日付</label>
                                    <input type="date" required value={manualDate} onChange={(e) => setManualDate(e.target.value)} className="w-full p-2 border rounded-md text-sm text-gray-700" />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-gray-600 mb-1">店舗名・支出先</label>
                                    <input type="text" required placeholder="例: セブンイレブン、電気代" value={manualShop} onChange={(e) => setManualShop(e.target.value)} className="w-full p-2 border rounded-md text-sm text-gray-700" />
                                </div>
                            </div>

                            <div className="space-y-2 border-t pt-3">
                                <label className="block text-xs font-bold text-gray-700">購入品目リスト</label>
                                {manualItems.map((item, idx) => (
                                    <div key={idx} className="flex flex-wrap gap-2 items-center bg-gray-50 p-2 rounded border">
                                        <input type="text" placeholder="品目・内容" required value={item.name} onChange={(e) => updateManualItem(idx, 'name', e.target.value)} className="flex-1 p-1.5 border rounded text-xs text-gray-700" />
                                        <input type="number" placeholder="金額" required min="0" value={item.price || ''} onChange={(e) => updateManualItem(idx, 'price', Number(e.target.value))} className="w-20 p-1.5 border rounded text-xs text-gray-700 font-mono text-right" />
                                        <select value={item.category} onChange={(e) => updateManualItem(idx, 'category', e.target.value)} className="w-24 p-1.5 border rounded text-xs text-gray-700 bg-white">
                                            {Object.keys(COLORS).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                        </select>
                                        <button type="button" onClick={() => removeManualItem(idx)} className="text-red-500 hover:bg-red-50 p-1 rounded text-xs" title="削除">✕</button>
                                    </div>
                                ))}
                                <button type="button" onClick={addManualItem} className="text-xs bg-gray-100 hover:bg-gray-200 border text-gray-600 px-3 py-1.5 rounded-md font-medium">
                                    ＋ 品目を追加する
                                </button>
                            </div>

                            <button type="submit" disabled={loading} className="w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-2.5 px-4 rounded-md disabled:bg-gray-400 mt-2 shadow-sm">
                                {loading ? '登録中...' : '支出を手動で登録する'}
                            </button>
                        </form>
                    )}
                </div>

                {/* エラーメッセージ（エラーがあるときだけ表示） */}
                {error && <div className="p-4 bg-red-50 text-red-500 rounded-md text-sm">{error}</div>}

                {/* 解析結果の表示（resultデータがあるときだけ表示） */}
                {result && inputTab === 'ai' && (
                    <div className="bg-white p-6 rounded-lg shadow border border-gray-200 space-y-4">
                        <h2 className="text-lg font-bold text-gray-800 border-b pb-2">今回の解析結果</h2>
                        <p className="text-sm"><span className="font-semibold">店舗:</span> {result.shopName} / <span className="font-semibold">日付:</span> {result.date}</p>
                        <div className="text-md font-bold text-blue-600 bg-blue-50 p-2 rounded">
                            合計金額: ￥{result.totalAmount.toLocaleString()}
                        </div>

                        {/* 購入品目のテーブル表示 */}
                        <div className="mt-4 overflow-x-auto border rounded-md">
                            <table className="w-full text-left text-xs border-collapse">
                                <thead>
                                    <tr className="bg-gray-50 border-b border-gray-200 text-gray-600 font-medium">
                                        <th className="py-2 px-3">品目名</th>
                                        <th className="py-2 px-3">カテゴリ</th>
                                        <th className="py-2 px-3 text-right">価格</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.items.map((item, index) => (
                                        <tr key={index} className="border-b border-gray-100 hover:bg-gray-50/50">
                                            <td className="py-2 px-3 text-gray-800 font-medium">{item.name}</td>
                                            <td className="py-2 px-3">
                                                <span className="inline-block bg-blue-50 text-blue-700 border border-blue-100 text-[10px] px-1.5 py-0.5 rounded">
                                                    {item.category}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3 text-right text-gray-800 font-mono">￥{item.price.toLocaleString()}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* 散財の可視化（グラフ表示）grid grid-cols-1 md:grid-cols-2 */}
                <div className="flex flex-col gap-6">

                    {/* 今月のカテゴリ */}
                    <div className="bg-white p-6 rounded-lg shadow border border-gray-200 flex flex-col h-[320px]">
                        <h2 className="text-lg font-bold text-gray-800 mb-2">
                            今月のカテゴリ別支出
                        </h2>
                        {pieChartData.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                                今月のデータはありません。
                            </div>
                        ) : (
                            <div className="flex-1 w-full h-full">
                                {/* Rechartsの円グラフ */}
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={pieChartData}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={50} // ドーナツグラフにする設定
                                            outerRadius={75}
                                            paddingAngle={3}
                                            dataKey="value"
                                        >
                                        </Pie>
                                        <Tooltip formatter={(value) => `￥${Number(value).toLocaleString()}`} />
                                        <Legend />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </div>

                    {/* 月ごと支出推移（折れ線グラフ） */}
                    <div className="bg-white p-6 rounded-lg shadow border border-gray-200 flex flex-col h-[320px]">
                        <h2 className="text-lg font-bold text-gray-800 mb-2">月ごとの支出推移</h2>
                        {lineChartData.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">データが蓄積されると推移が表示されます。</div>
                        ) : (
                            <div className="flex-1 w-full h-full text-xs">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={lineChartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" />
                                        <XAxis dataKey="name" />
                                        <YAxis tickFormatter={(v) => `￥${v}`} />
                                        <Tooltip formatter={(value) => `￥${Number(value).toLocaleString()}`} />
                                        <Line type="monotone" dataKey="支出" stroke="#3B82F6" strokeWidth={3} activeDot={{ r: 8 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* カレンダー履歴 */}
            <div className="bg-white p-6 rounded-lg shadow border border-gray-200 space-y-6">
                <div className="flex flex-col md:flex-row justify-between md:items-center select-none border-b pb-3">
                    <h2 className="text-xl font-bold text-gray-800">支出カレンダー履歴</h2>

                    <div className="flex flex-col md:flex-row md:items-center gap-4">
                        {/* 月別合計額 */}
                        <p className="text-xs text-gray-500 font-medium ">
                            月間合計: <span className="font-bold text-blue-600 text-sm">
                                ￥{(() => {
                                    const targetMonth = monthlyHistory.find(m => m.month === currentMonthKey);
                                    return (targetMonth?.days.reduce((sum, d) => sum + d.total_amount, 0) || 0).toLocaleString();
                                })()}
                            </span>
                        </p>

                        <div className="flex  justify-between items-center gap-4 bg-gray-100 px-3 py-1.5 rounded-lg border">
                            <button onClick={() => changeMonth(-1)} className="text-gray-600 hover:text-blue-600 font-bold px-2 text-sm">◀ 前月</button>
                            <span className="font-bold text-gray-700 text-sm">
                                {currentDate.getFullYear()}年{currentDate.getMonth() + 1}月
                            </span>
                            <button onClick={() => changeMonth(1)} className="text-gray-600 hover:text-blue-600 font-bold px-2 text-sm">次月 ▶</button>
                        </div>
                    </div>
                </div>

                {/* カレンダー本体 */}
                <div>
                    {/* 曜日ヘッダー */}
                    <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-gray-500 border-b pb-2 mb-1">
                        <div className="text-red-500">日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div className="text-blue-500">土</div>
                    </div>
                    {/* 日付グリッド */}
                    <div className="grid grid-cols-7 gap-1 bg-gray-200 p-1 rounded-lg">
                        {getCalendarDays().map((day, idx) => {
                            if (day === null) return <div key={`empty-${idx}`} className="bg-gray-50/40 min-h-[64px] rounded-md"></div>;

                            // このマスの日付文字列を作る (YYYY-MM-DD)
                            const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

                            // monthlyHistoryからこの日のデータを探す
                            const currentMonthKey = `${currentDate.getFullYear()}年${String(currentDate.getMonth() + 1).padStart(2, '0')}月`;
                            const targetMonth = monthlyHistory.find(m => m.month === currentMonthKey);
                            const dayData = targetMonth?.days?.find(d => d.purchase_date === dateStr);
                            const isSelected = selectedDayData?.purchase_date === dateStr;
                            return (
                                <button
                                    key={`day-${day}`}
                                    onClick={() => dayData && setSelectedDayData(dayData)}
                                    disabled={!dayData}
                                    className={`min-h-[68px] p-1.5 flex flex-col justify-between text-left rounded-md border transition bg-white group
                                        ${dayData ? 'hover:bg-blue-50/50 border-gray-300 cursor-pointer shadow-sm' : 'border-gray-100 text-gray-400 opacity-60'}
                                        ${isSelected ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-200' : ''}
                                    `}
                                >
                                    <span className="text-xs font-bold font-mono text-gray-700">{day}</span>
                                    {dayData && (
                                        <span className="text-[10px] sm:text-xs font-mono font-bold text-blue-600 text-right w-full bg-blue-50/50 rounded px-1 group-hover:bg-white truncate">
                                            ￥{dayData.total_amount.toLocaleString()}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 選択された日の詳細表示エリア（カレンダーの下に展開） */}
                {selectedDayData ? (
                    <div className="bg-gray-50 p-4 rounded-xl border border-blue-200 mt-4 space-y-4 shadow-inner animation-fade-in">
                        <div className="flex justify-between items-center border-b border-gray-200 pb-2">
                            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                                <span className="bg-blue-500 text-white px-2 py-0.5 rounded text-xs font-mono">{selectedDayData.purchase_date}</span>
                                の支出詳細内訳
                            </h3>
                            <button onClick={() => setSelectedDayData(null)} className="text-xs text-gray-400 hover:text-gray-600">✕ 閉じる</button>
                        </div>

                        <div className="space-y-4">
                            {selectedDayData.receipts.map((receipt, rIdx) => (
                                <div key={rIdx} className="space-y-1.5 bg-white p-3 rounded-lg border border-gray-200 shadow-sm">
                                    <div className="flex justify-between items-center text-xs font-bold text-gray-600 bg-gray-100/80 px-2 py-1.5 rounded">
                                        <span>🧾 {receipt.shop_name}</span>
                                        <span className="font-mono text-blue-600 text-sm">￥{receipt.total_amount.toLocaleString()}</span>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-xs border-collapse">
                                            <thead>
                                                <tr className="bg-gray-50 border-b text-gray-500 font-medium">
                                                    <th className="py-1.5 px-3">品目名</th>
                                                    <th className="py-1.5 px-3">カテゴリ</th>
                                                    <th className="py-1.5 px-3 text-right">価格</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {receipt.receipt_items.map((item, idx) => (
                                                    <tr key={idx} className="border-b last:border-b-0 border-gray-100 hover:bg-gray-50/50">
                                                        <td className="py-2 px-3 text-gray-800 font-medium">{item.name}</td>
                                                        <td className="py-2 px-3">
                                                            <span className="inline-block bg-emerald-50 text-emerald-700 border border-emerald-100 text-[10px] px-1.5 py-0.5 rounded">{item.category}</span>
                                                        </td>
                                                        <td className="py-2 px-3 text-right text-gray-800 font-mono">￥{item.price.toLocaleString()}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            ))}
                        </div>

                    </div>
                ) : (
                    <div className="text-center py-6 text-xs text-gray-400 bg-gray-50 rounded-lg border border-dashed">
                        カレンダーで金額が表示されている日付をクリックすると、ここに店舗・商品別の詳細内訳が表示されます。
                    </div>
                )}
            </div>
        </main>
    );
}