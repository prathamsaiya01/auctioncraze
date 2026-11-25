export interface FranchisePreset {
  code: string;
  name: string;
  shortName: string;
  primaryColor: string;
  secondaryColor: string;
  city: string;
}

export const IPL_FRANCHISE_PRESETS: readonly FranchisePreset[] = [
  {
    code: 'CSK',
    name: 'Chennai Super Kings',
    shortName: 'CSK',
    primaryColor: '#F9CD05',
    secondaryColor: '#1D4ED8',
    city: 'Chennai'
  },
  {
    code: 'MI',
    name: 'Mumbai Indians',
    shortName: 'MI',
    primaryColor: '#004BA0',
    secondaryColor: '#D4AF37',
    city: 'Mumbai'
  },
  {
    code: 'RCB',
    name: 'Royal Challengers Bengaluru',
    shortName: 'RCB',
    primaryColor: '#EC1C24',
    secondaryColor: '#D4AF37',
    city: 'Bengaluru'
  },
  {
    code: 'KKR',
    name: 'Kolkata Knight Riders',
    shortName: 'KKR',
    primaryColor: '#3A225D',
    secondaryColor: '#D4AF37',
    city: 'Kolkata'
  },
  {
    code: 'SRH',
    name: 'Sunrisers Hyderabad',
    shortName: 'SRH',
    primaryColor: '#F76B1C',
    secondaryColor: '#1E293B',
    city: 'Hyderabad'
  },
  {
    code: 'RR',
    name: 'Rajasthan Royals',
    shortName: 'RR',
    primaryColor: '#EA1A85',
    secondaryColor: '#1E3A8A',
    city: 'Jaipur'
  },
  {
    code: 'DC',
    name: 'Delhi Capitals',
    shortName: 'DC',
    primaryColor: '#17479E',
    secondaryColor: '#EF4444',
    city: 'Delhi'
  },
  {
    code: 'PBKS',
    name: 'Punjab Kings',
    shortName: 'PBKS',
    primaryColor: '#DD1F2D',
    secondaryColor: '#E2E8F0',
    city: 'Mohali'
  },
  {
    code: 'GT',
    name: 'Gujarat Titans',
    shortName: 'GT',
    primaryColor: '#1B2133',
    secondaryColor: '#D4AF37',
    city: 'Ahmedabad'
  },
  {
    code: 'LSG',
    name: 'Lucknow Super Giants',
    shortName: 'LSG',
    primaryColor: '#0EA5E9',
    secondaryColor: '#F97316',
    city: 'Lucknow'
  }
] as const;

export const FRANCHISE_CODES = IPL_FRANCHISE_PRESETS.map((f) => f.code);
