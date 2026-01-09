import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string;
}

export interface CreditPackage {
  id: string;
  credits: number;
  price: number;
  currency: string;
  name: string;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  credits: number | null;
  creditPackages: CreditPackage[];
  login: () => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshCredits: () => Promise<void>;
  purchaseCredits: (packageId: string) => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditPackages, setCreditPackages] = useState<CreditPackage[]>([]);

  const refreshCredits = useCallback(async () => {
    try {
      const response = await fetch('/api/credits');
      if (response.ok) {
        const data = (await response.json()) as { credits: number; packages: CreditPackage[] };
        setCredits(data.credits);
        setCreditPackages(data.packages);
      }
    } catch (error) {
      console.error('Failed to fetch credits:', error);
    }
  }, []);

  const refreshUser = async () => {
    try {
      const response = await fetch('/api/auth/me');
      if (response.ok) {
        const data = (await response.json()) as { user: User | null };
        setUser(data.user);
        if (data.user) {
          // Fetch credits when user is logged in
          await refreshCredits();
        }
      }
    } catch (error) {
      console.error('Failed to fetch user:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  // Check for payment success/cancel in URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const payment = urlParams.get('payment');
    const sessionId = urlParams.get('session_id');

    if (payment === 'success' && sessionId) {
      // Verify the checkout session and add credits
      const verifyPayment = async () => {
        try {
          const response = await fetch(`/api/stripe/verify-session?session_id=${sessionId}`);
          if (response.ok) {
            const data = await response.json() as { success: boolean; credits?: number; creditsAdded?: number };
            if (data.success && data.credits !== undefined) {
              setCredits(data.credits);
              if (data.creditsAdded) {
                console.log(`Payment verified: ${data.creditsAdded} credits added`);
              }
            }
          } else {
            console.error('Failed to verify payment session');
            // Fallback to refreshing credits
            await refreshCredits();
          }
        } catch (error) {
          console.error('Error verifying payment:', error);
          await refreshCredits();
        }
      };
      verifyPayment();
      // Remove the query params from URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (payment === 'cancelled') {
      // Just remove the query param
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [refreshCredits]);

  const login = () => {
    // Redirect to Google OAuth
    window.location.href = '/api/auth/google';
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setCredits(null);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const purchaseCredits = async (packageId: string) => {
    try {
      const response = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId }),
      });

      if (!response.ok) {
        const error = await response.json() as { error: string };
        throw new Error(error.error || 'Failed to create checkout session');
      }

      const data = (await response.json()) as { url: string };
      // Redirect to Stripe checkout
      window.location.href = data.url;
    } catch (error) {
      console.error('Failed to purchase credits:', error);
      throw error;
    }
  };

  return (
    <UserContext.Provider value={{
      user,
      loading,
      credits,
      creditPackages,
      login,
      logout,
      refreshUser,
      refreshCredits,
      purchaseCredits,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
