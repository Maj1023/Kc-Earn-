import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
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

const API_BASE_URL = 'https://kc-earn.onrender.com';
const API_ORIGIN = API_BASE_URL;

type Screen = 'welcome' | 'login' | 'register' | 'dashboard';
type Country = { code: string; name: string; currency: string };
type User = {
  id: string;
  fullName: string;
  email: string;
  countryCode: string;
  currency: string;
  isAdmin: boolean;
};
type Wallet = {
  balanceKobo?: string;
  balanceNaira?: string;
  balanceMinor?: string;
  balance?: string;
  currency: string;
  countryCode?: string;
};

async function apiRequest(path: string, method = 'GET', body?: object) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { Origin: API_ORIGIN } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'KC EARN could not complete your request.');
  return data;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryCode, setCountryCode] = useState('NG');
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingCountries, setLoadingCountries] = useState(true);

  const selectedCountry = countries.find(country => country.code === countryCode);

  useEffect(() => {
    let active = true;
    apiRequest('/api/countries')
      .then(data => {
        if (active && Array.isArray(data.countries)) setCountries(data.countries);
      })
      .catch(error => {
        if (active) Alert.alert('Country list unavailable', error.message);
      })
      .finally(() => {
        if (active) setLoadingCountries(false);
      });
    return () => { active = false; };
  }, []);

  const loadAccount = async (accountUser: User) => {
    setUser(accountUser);
    const data = await apiRequest('/api/wallet');
    setWallet(data.wallet);
    setScreen('dashboard');
  };

  const submit = async () => {
    if (loading) return;
    if (!email.trim() || !password) {
      Alert.alert('Missing details', 'Enter your email address and password.');
      return;
    }
    if (screen === 'register' && name.trim().length < 2) {
      Alert.alert('Name required', 'Enter your full name.');
      return;
    }
    if (screen === 'register' && password.length < 8) {
      Alert.alert('Password too short', 'Your password must contain at least 8 characters.');
      return;
    }
    if (screen === 'register' && !selectedCountry) {
      Alert.alert('Country unavailable', 'Please wait for the African country list to load.');
      return;
    }

    setLoading(true);
    try {
      const path = screen === 'register' ? '/api/register' : '/api/login';
      const payload = screen === 'register'
        ? { fullName: name.trim(), email: email.trim(), password, countryCode }
        : { email: email.trim(), password };
      const data = await apiRequest(path, 'POST', payload);
      await loadAccount(data.user);
      setPassword('');
    } catch (error) {
      Alert.alert('KC EARN', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const refreshWallet = async () => {
    try {
      const data = await apiRequest('/api/wallet');
      setWallet(data.wallet);
    } catch (error) {
      Alert.alert('Wallet unavailable', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  const signOut = async () => {
    try {
      await apiRequest('/api/logout', 'POST', {});
    } catch (error) {
      Alert.alert('Sign out', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setUser(null);
      setWallet(null);
      setScreen('welcome');
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
                <Text style={styles.description}>One account for our growing African rewards platform. Your available earning and payout services depend on verified support in your country.</Text>
                <View style={styles.features}>
                  <Feature emoji="🌍" title="Across Africa" detail="Choose from 54 African countries." />
                  <Feature emoji="💰" title="Local currency" detail="Your wallet displays your account currency." />
                  <Feature emoji="🔒" title="Real rewards only" detail="No invented earnings or unsupported payouts." />
                </View>
                <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('register')}>
                  <Text style={styles.primaryText}>Create Account</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('login')}>
                  <Text style={styles.secondaryText}>Already have an account? Sign in</Text>
                </TouchableOpacity>
              </>
            )}

            {(screen === 'register' || screen === 'login') && (
              <>
                <Text style={styles.heading}>{screen === 'register' ? 'Create your account' : 'Welcome back'}</Text>
                <Text style={styles.description}>{screen === 'register' ? 'Register once and select your African country.' : 'Sign in to your existing KC EARN account.'}</Text>
                {screen === 'register' && (
                  <>
                    <TextInput style={styles.input} placeholder="Full name" placeholderTextColor="#8993A7" value={name} onChangeText={setName} autoCapitalize="words" />
                    <TouchableOpacity style={styles.countryButton} onPress={() => setCountryPickerOpen(true)} disabled={loadingCountries}>
                      <Text style={styles.countryButtonText}>{loadingCountries ? 'Loading countries…' : selectedCountry ? `${selectedCountry.name} · ${selectedCountry.currency}` : 'Select your country'}</Text>
                      <Text style={styles.countryArrow}>⌄</Text>
                    </TouchableOpacity>
                  </>
                )}
                <TextInput style={styles.input} placeholder="Email address" placeholderTextColor="#8993A7" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} value={email} onChangeText={setEmail} />
                <TextInput style={styles.input} placeholder="Password (minimum 8 characters)" placeholderTextColor="#8993A7" secureTextEntry value={password} onChangeText={setPassword} />
                <TouchableOpacity style={[styles.primaryButton, loading && styles.disabledButton]} onPress={submit} disabled={loading}>
                  {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>{screen === 'register' ? 'Create Account' : 'Sign In'}</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen(screen === 'register' ? 'login' : 'register')}>
                  <Text style={styles.secondaryText}>{screen === 'register' ? 'Already registered? Sign in' : "Don't have an account? Register"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.backButton} onPress={() => setScreen('welcome')}>
                  <Text style={styles.backText}>← Back to welcome</Text>
                </TouchableOpacity>
              </>
            )}

            {screen === 'dashboard' && user && (
              <>
                <Text style={styles.heading}>Hello, {user.fullName}</Text>
                <Text style={styles.description}>{user.countryCode} · {user.currency} account</Text>
                <View style={styles.walletCard}>
                  <Text style={styles.walletLabel}>Your wallet balance</Text>
                  <Text style={styles.walletAmount}>{wallet ? (wallet.currency === 'NGN' ? `₦${wallet.balanceNaira || '0.00'}` : `${wallet.currency} ${wallet.balance || '0'}`) : 'Loading…'}</Text>
                  <Text style={styles.walletCaption}>Currency: {wallet?.currency || user.currency}</Text>
                  <TouchableOpacity onPress={refreshWallet} style={styles.refreshButton}><Text style={styles.refreshText}>Refresh balance</Text></TouchableOpacity>
                </View>
                {user.countryCode === 'NG' ? (
                  <View style={styles.noticeCard}>
                    <Text style={styles.noticeTitle}>Nigeria services</Text>
                    <Text style={styles.noticeText}>Offerzy and Nigerian withdrawal features are available through the existing web account. This mobile screen currently provides account access and wallet balance.</Text>
                  </View>
                ) : (
                  <View style={styles.noticeCard}>
                    <Text style={styles.noticeTitle}>Local earning and withdrawals not active yet</Text>
                    <Text style={styles.noticeText}>Your country and currency are saved correctly. We have not activated rewards or withdrawals until a provider and real payout route are verified for your market. Your displayed balance is not a promise of earnings.</Text>
                  </View>
                )}
                <TouchableOpacity style={styles.primaryButton} onPress={signOut}><Text style={styles.primaryText}>Sign Out</Text></TouchableOpacity>
              </>
            )}
            <Text style={styles.footer}>KC EARN  •  K.C. VENTURES</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={countryPickerOpen} animationType="slide" onRequestClose={() => setCountryPickerOpen(false)}>
        <SafeAreaView style={styles.modalSafe}>
          <Text style={styles.modalTitle}>Choose your African country</Text>
          <FlatList
            data={countries}
            keyExtractor={item => item.code}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.countryRow} onPress={() => { setCountryCode(item.code); setCountryPickerOpen(false); }}>
                <Text style={styles.countryName}>{item.name}</Text>
                <Text style={styles.countryCurrency}>{item.currency}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.emptyText}>Country list unavailable. Check your internet connection and reopen the app.</Text>}
          />
          <TouchableOpacity style={styles.modalClose} onPress={() => setCountryPickerOpen(false)}><Text style={styles.secondaryText}>Close</Text></TouchableOpacity>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Feature({ emoji, title, detail }: { emoji: string; title: string; detail: string }) {
  return <View style={styles.feature}><Text style={styles.featureEmoji}>{emoji}</Text><View style={styles.featureInfo}><Text style={styles.featureTitle}>{title}</Text><Text style={styles.featureDetail}>{detail}</Text></View></View>;
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
  countryButton: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E1E7F0', borderRadius: 13, paddingHorizontal: 16, height: 55, marginBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  countryButtonText: { color: '#18335F', fontSize: 15 },
  countryArrow: { color: '#68758C', fontSize: 22 },
  primaryButton: { height: 55, borderRadius: 14, backgroundColor: '#1764DC', alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  disabledButton: { opacity: 0.65 },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  secondaryButton: { alignItems: 'center', paddingVertical: 19 },
  secondaryText: { color: '#1764DC', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  backButton: { alignItems: 'center', paddingVertical: 10 },
  backText: { color: '#68758C', fontSize: 14 },
  footer: { textAlign: 'center', color: '#9AA5B6', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 22, marginBottom: 10 },
  walletCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, marginBottom: 16 },
  walletLabel: { color: '#68758C', fontSize: 13 },
  walletAmount: { color: '#142B55', fontSize: 30, fontWeight: '900', marginTop: 8 },
  walletCaption: { color: '#7A879B', fontSize: 12, marginTop: 5 },
  refreshButton: { alignSelf: 'flex-start', paddingTop: 14 },
  refreshText: { color: '#1764DC', fontWeight: '700' },
  noticeCard: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 17, marginBottom: 18 },
  noticeTitle: { color: '#18335F', fontSize: 15, fontWeight: '800', marginBottom: 7 },
  noticeText: { color: '#68758C', fontSize: 13, lineHeight: 20 },
  modalSafe: { flex: 1, backgroundColor: '#F4F7FC', paddingTop: 20 },
  modalTitle: { color: '#142B55', fontSize: 21, fontWeight: '800', paddingHorizontal: 20, paddingBottom: 16 },
  countryRow: { backgroundColor: '#FFFFFF', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#EEF1F6', flexDirection: 'row', justifyContent: 'space-between' },
  countryName: { color: '#18335F', fontSize: 15 },
  countryCurrency: { color: '#68758C', fontSize: 14, fontWeight: '700' },
  emptyText: { color: '#68758C', padding: 20 },
  modalClose: { alignItems: 'center', padding: 18, backgroundColor: '#FFFFFF' },
});
