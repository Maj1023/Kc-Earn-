import React, { useState } from 'react';
import {
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

type Screen = 'welcome' | 'login' | 'register';

export default function App() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = () => {
    Alert.alert(
      'KC Earn',
      'The interface is ready. Account services will be connected to the backend in the next development stage.'
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.logo}>
              <Text style={styles.logoText}>KC</Text>
            </View>
            <Text style={styles.brand}>KC EARN</Text>
            <Text style={styles.tagline}>Earn more. Do more.</Text>
          </View>

          <View style={styles.content}>
            {screen === 'welcome' ? (
              <>
                <Text style={styles.heading}>Welcome to KC Earn</Text>
                <Text style={styles.description}>
                  Your journey to earning rewards online starts here.
                  Complete activities, discover opportunities and earn rewards.
                </Text>

                <View style={styles.features}>
                  <Feature emoji="📋" title="Paid Surveys" detail="Share your opinions and earn rewards." />
                  <Feature emoji="🎯" title="Online Offers" detail="Discover available earning opportunities." />
                  <Feature emoji="👥" title="Refer Friends" detail="Invite friends to join KC Earn." />
                  <Feature emoji="💰" title="Your Wallet" detail="Keep track of your rewards and withdrawals." />
                </View>

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => setScreen('register')}
                >
                  <Text style={styles.primaryText}>Create Account</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setScreen('login')}
                >
                  <Text style={styles.secondaryText}>Already have an account? Sign in</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.heading}>
                  {screen === 'register' ? 'Create your account' : 'Welcome back'}
                </Text>
                <Text style={styles.description}>
                  {screen === 'register'
                    ? 'Join KC Earn and explore earning opportunities.'
                    : 'Sign in to continue to KC Earn.'}
                </Text>

                {screen === 'register' && (
                  <TextInput
                    style={styles.input}
                    placeholder="Full name"
                    placeholderTextColor="#8993A7"
                    value={name}
                    onChangeText={setName}
                  />
                )}

                <TextInput
                  style={styles.input}
                  placeholder="Email address"
                  placeholderTextColor="#8993A7"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  value={email}
                  onChangeText={setEmail}
                />

                <TextInput
                  style={styles.input}
                  placeholder="Password"
                  placeholderTextColor="#8993A7"
                  secureTextEntry
                  value={password}
                  onChangeText={setPassword}
                />

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={submit}
                >
                  <Text style={styles.primaryText}>
                    {screen === 'register' ? 'Create Account' : 'Sign In'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setScreen(screen === 'register' ? 'login' : 'register')}
                >
                  <Text style={styles.secondaryText}>
                    {screen === 'register'
                      ? 'Already registered? Sign in'
                      : "Don't have an account? Register"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.backButton}
                  onPress={() => setScreen('welcome')}
                >
                  <Text style={styles.backText}>← Back to welcome</Text>
                </TouchableOpacity>
              </>
            )}

            <Text style={styles.footer}>
              KC EARN  •  K.C. VENTURES
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Feature({
  emoji,
  title,
  detail,
}: {
  emoji: string;
  title: string;
  detail: string;
}) {
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
  safe: {
    flex: 1,
    backgroundColor: '#102B66',
  },
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    backgroundColor: '#F4F7FC',
  },
  header: {
    backgroundColor: '#102B66',
    alignItems: 'center',
    paddingTop: 32,
    paddingBottom: 42,
  },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  logoText: {
    color: '#1764DC',
    fontSize: 30,
    fontWeight: '900',
  },
  brand: {
    color: '#FFFFFF',
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: 3,
  },
  tagline: {
    color: '#C8D9FF',
    fontSize: 14,
    marginTop: 7,
  },
  content: {
    flex: 1,
    backgroundColor: '#F4F7FC',
    marginTop: -15,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 24,
  },
  heading: {
    color: '#142B55',
    fontSize: 25,
    fontWeight: '800',
    marginTop: 10,
  },
  description: {
    color: '#68758C',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 22,
  },
  features: {
    gap: 13,
    marginBottom: 25,
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 15,
    borderRadius: 15,
  },
  featureEmoji: {
    fontSize: 27,
    marginRight: 14,
  },
  featureInfo: {
    flex: 1,
  },
  featureTitle: {
    color: '#18335F',
    fontSize: 15,
    fontWeight: '700',
  },
  featureDetail: {
    color: '#7A879B',
    fontSize: 12,
    marginTop: 4,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E1E7F0',
    borderRadius: 13,
    paddingHorizontal: 16,
    height: 55,
    fontSize: 15,
    color: '#18335F',
    marginBottom: 14,
  },
  primaryButton: {
    height: 55,
    borderRadius: 14,
    backgroundColor: '#1764DC',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 5,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    paddingVertical: 19,
  },
  secondaryText: {
    color: '#1764DC',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  backButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  backText: {
    color: '#68758C',
    fontSize: 14,
  },
  footer: {
    textAlign: 'center',
    color: '#9AA5B6',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 22,
    marginBottom: 10,
  },
});
