import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';

type Screen = 'welcome' | 'login' | 'register' | 'dashboard';
type User = { id: string | number; fullName: string; email: string; isAdmin: boolean };
type Transaction = {
  id: string | number;
  type: 'credit' | 'debit';
  amountNaira: string;
  description: string;
  reference: string;
  createdAt: string;
};
type Wallet = { balanceNaira: string; currency: string };

const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://kc-earn.onrender.com').replace(/\/+$/, '');
const TOKEN_KEY = 'kc_earn_session_token';

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; mobileAuth?: boolean } = {}
): Promise<T> {
  if (!API_URL) {
    throw new Error('KC Earn API address is not configured. Set EXPO_PUBLIC_API_URL to your deployed HTTPS backend URL.');
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.mobileAuth) headers['X-KC-Client'] = 'mobile';

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error('Could not reach KC Earn. Check your internet connection and API address.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      typeof data.error === 'string' ? data.error : 'The request could not be completed.',
      response.status
    );
  }
  return data as T;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  const loadAccount = useCallback(async (token: string) => {
    const [me, walletData, transactionData] = await Promise.all([
      apiRequest<{ user: User }>('/api/me', { token }),
      apiRequest<{ wallet: Wallet }>('/api/wallet', { token }),
      apiRequest<{ transactions: Transaction[] }>('/api/wallet/transactions', { token }),
    ]);
    setUser(me.user);
    setWallet(walletData.wallet);
    setTransactions(transactionData.transactions);
    setScreen('dashboard');
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        if (token) {
          const [me, walletData, transactionData] = await Promise.all([
            apiRequest<{ user: User }>('/api/me', { token }),
            apiRequest<{ wallet: Wallet }>('/api/wallet', { token }),
            apiRequest<{ transactions: Transaction[] }>('/api/wallet/transactions', { token }),
          ]);
          if (!active) return;
          setUser(me.user);
          setWallet(walletData.wallet);
          setTransactions(transactionData.transactions);
          setScreen('dashboard');
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
        } else if (active) {
          setNotice(error instanceof Error ? error.message : 'Could not restore your session.');
        }
      }
    })();
    return () => { active = false; };
  }, []);

  const submit = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password || (screen === 'register' && !name.trim())) {
      Alert.alert('Missing information', 'Please complete all required fields.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const path = screen === 'register' ? '/api/register' : '/api/login';
      const body = screen === 'register'
        ? { fullName: name.trim(), email: cleanEmail, password }
        : { email: cleanEmail, password };
      const result = await apiRequest<{ message: string; sessionToken?: string; user: User }>(
        path, { method: 'POST', body, mobileAuth: true }
      );
      if (!result.sessionToken) {
        throw new Error('The server did not return a mobile session. Please update the backend before signing in.');
      }
      await SecureStore.setItemAsync(TOKEN_KEY, result.sessionToken);
      setPassword('');
      await loadAccount(result.sessionToken);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const refreshAccount = async () => {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) {
      setScreen('login');
      return;
    }
    setRefreshing(true);
    try {
      await loadAccount(token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
        setUser(null);
        setWallet(null);
        setTransactions([]);
        setScreen('login');
      }
      setNotice(error instanceof Error ? error.message : 'Could not refresh account.');
    } finally {
      setRefreshing(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (token) {
        await apiRequest('/api/logout', { method: 'POST', token });
      }
    } catch {
      // Clear the local credential even if the device is offline.
    } finally {
      await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
      setUser(null);
      setWallet(null);
      setTransactions([]);
      setScreen('welcome');
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={styles.logo}><Text style={styles.logoText}>KC</Text></View>
            <Text style={styles.brand}>KC EARN</Text>
            <Text style={styles.tagline}>Earn more. Do more.</Text>
          </View>

          <View style={styles.content}>
            {screen === 'welcome' && (
              <>
                <Text style={styles.heading}>Welcome to KC Earn</Text>
                <Text style={styles.description}>Your journey to earning rewards online starts here. Complete activities, discover opportunities and track your rewards.</Text>
                <View style={styles.features}>
                  <Feature emoji="📋" title="Paid Surveys" detail="Share your opinions and earn rewards." />
                  <Feature emoji="🎯" title="Online Offers" detail="Discover available earning opportunities." />
                  <Feature emoji="👥" title="Refer Friends" detail="Invite friends to join KC Earn." />
                  <Feature emoji="💰" title="Your Wallet" detail="Track verified rewards and withdrawals." />
                </View>
                <TouchableOpacity style={styles.primaryButton} onPress={() => { setNotice(''); setScreen('register'); }}>
                  <Text style={styles.primaryText}>Create Account</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => { setNotice(''); setScreen('login'); }}>
                  <Text style={styles.secondaryText}>Already have an account? Sign in</Text>
                </TouchableOpacity>
              </>
            )}

            {(screen === 'login' || screen === 'register') && (
              <>
                <Text style={styles.heading}>{screen === 'register' ? 'Create your account' : 'Welcome back'}</Text>
                <Text style={styles.description}>{screen === 'register' ? 'Join KC Earn and explore genuine earning opportunities.' : 'Sign in to continue to KC Earn.'}</Text>
                {screen === 'register' && <TextInput style={styles.input} placeholder="Full name" placeholderTextColor="#8993A7" value={name} onChangeText={setName} autoCapitalize="words" />}
                <TextInput style={styles.input} placeholder="Email address" placeholderTextColor="#8993A7" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} value={email} onChangeText={setEmail} />
                <TextInput style={styles.input} placeholder="Password (at least 8 characters)" placeholderTextColor="#8993A7" secureTextEntry value={password} onChangeText={setPassword} />
                {!!notice && <Text style={styles.error}>{notice}</Text>}
                <TouchableOpacity style={[styles.primaryButton, busy && styles.disabled]} onPress={submit} disabled={busy}>
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>{screen === 'register' ? 'Create Account' : 'Sign In'}</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => { setNotice(''); setScreen(screen === 'register' ? 'login' : 'register'); }}>
                  <Text style={styles.secondaryText}>{screen === 'register' ? 'Already registered? Sign in' : "Don't have an account? Register"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.backButton} onPress={() => { setNotice(''); setScreen('welcome'); }}>
                  <Text style={styles.backText}>← Back to welcome</Text>
                </TouchableOpacity>
              </>
            )}

            {screen === 'dashboard' && (
              <>
                <Text style={styles.heading}>Hello, {user?.fullName || 'there'}!</Text>
                <Text style={styles.description}>Your KC Earn account overview.</Text>
                <View style={styles.walletCard}>
                  <Text style={styles.walletLabel}>AVAILABLE WALLET BALANCE</Text>
                  <Text style={styles.walletAmount}>₦{wallet?.balanceNaira ?? '0.00'}</Text>
                  <Text style={styles.walletCurrency}>{wallet?.currency || 'NGN'} · Verified account balance</Text>
                </View>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Recent transactions</Text>
                  <TouchableOpacity onPress={refreshAccount} disabled={refreshing}>
                    <Text style={styles.refreshText}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
                  </TouchableOpacity>
                </View>
                {!!notice && <Text style={styles.error}>{notice}</Text>}
                {transactions.length === 0 ? (
                  <Text style={styles.empty}>No wallet transactions yet. Verified rewards will appear here.</Text>
                ) : transactions.map(item => (
                  <View key={String(item.id)} style={styles.transaction}>
                    <View style={styles.transactionInfo}>
                      <Text style={styles.transactionTitle}>{item.description}</Text>
                      <Text style={styles.transactionDate}>{new Date(item.createdAt).toLocaleString()}</Text>
                    </View>
                    <Text style={[styles.transactionAmount, item.type === 'credit' ? styles.credit : styles.debit]}>
                      {item.type === 'credit' ? '+' : '−'}₦{item.amountNaira}
                    </Text>
                  </View>
                ))}
                <TouchableOpacity style={styles.secondaryButton} onPress={logout} disabled={busy}>
                  <Text style={styles.secondaryText}>{busy ? 'Signing out…' : 'Sign out'}</Text>
                </TouchableOpacity>
              </>
            )}
            <Text style={styles.footer}>KC EARN  •  K.C. VENTURES</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Feature({ emoji, title, detail }: { emoji: string; title: string; detail: string }) {
  return (
    <View style={styles.feature}>
      <Text style={styles.featureEmoji}>{emoji}</Text>
      <View style={styles.featureInfo}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureDetail}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#102B66' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, backgroundColor: '#F4F7FC' },
  header: { backgroundColor: '#102B66', alignItems: 'center', paddingTop: 32, paddingBottom: 42 },
  logo: { width: 76, height: 76, borderRadius: 24, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  logoText: { color: '#1764DC', fontSize: 30, fontWeight: '900' },
  brand: { color: '#FFFFFF', fontSize: 27, fontWeight: '900', letterSpacing: 3 },
  tagline: { color: '#C8D9FF', fontSize: 14, marginTop: 7 },
  content: { flex: 1, backgroundColor: '#F4F7FC', marginTop: -15, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 24 },
  heading: { color: '#142B55', fontSize: 25, fontWeight: '800', marginTop: 10 },
  description: { color: '#68758C', fontSize: 14, lineHeight: 22, marginTop: 10, marginBottom: 22 },
  features: { gap: 13, marginBottom: 25 },
  feature: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 15, borderRadius: 15 },
  featureEmoji: { fontSize: 27, marginRight: 14 },
  featureInfo: { flex: 1 },
  featureTitle: { color: '#18335F', fontSize: 15, fontWeight: '700' },
  featureDetail: { color: '#7A879B', fontSize: 12, marginTop: 4 },
  input: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E1E7F0', borderRadius: 13, paddingHorizontal: 16, height: 55, fontSize: 15, color: '#18335F', marginBottom: 14 },
  primaryButton: { height: 55, borderRadius: 14, backgroundColor: '#1764DC', alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  secondaryButton: { alignItems: 'center', paddingVertical: 19 },
  secondaryText: { color: '#1764DC', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  backButton: { alignItems: 'center', paddingVertical: 10 },
  backText: { color: '#68758C', fontSize: 14 },
  error: { color: '#B42318', fontSize: 13, lineHeight: 19, marginBottom: 12 },
  walletCard: { backgroundColor: '#102B66', borderRadius: 18, padding: 22, marginBottom: 25 },
  walletLabel: { color: '#C8D9FF', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  walletAmount: { color: '#FFFFFF', fontSize: 34, fontWeight: '900', marginTop: 12 },
  walletCurrency: { color: '#C8D9FF', fontSize: 12, marginTop: 6 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { color: '#142B55', fontSize: 17, fontWeight: '800' },
  refreshText: { color: '#1764DC', fontWeight: '700' },
  empty: { color: '#68758C', backgroundColor: '#FFFFFF', padding: 18, borderRadius: 13, lineHeight: 21 },
  transaction: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 14, borderRadius: 13, marginBottom: 9 },
  transactionInfo: { flex: 1, marginRight: 8 },
  transactionTitle: { color: '#18335F', fontSize: 13, fontWeight: '700' },
  transactionDate: { color: '#8993A7', fontSize: 11, marginTop: 5 },
  transactionAmount: { fontSize: 13, fontWeight: '800' },
  credit: { color: '#138A4B' },
  debit: { color: '#B42318' },
  disabled: { opacity: 0.6 },
  footer: { textAlign: 'center', color: '#9AA5B6', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 22, marginBottom: 10 },
});
