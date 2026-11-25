import { PrismaClient, CricketRole, BattingStyle, BowlingStyle } from '@prisma/client';

const prisma = new PrismaClient();

// Verified factual player identity & role catalog (zero fabricated statistics).
// Full historical IPL statistics & bulk CSV/Excel imports will expand this in Phase 8.
const INITIAL_PLAYERS = [
  {
    externalKey: 'virat-kohli',
    fullName: 'Virat Kohli',
    nationality: 'India',
    isOverseas: false,
    age: 36,
    playingRole: CricketRole.BATSMAN,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_MEDIUM,
    basePriceLakhs: 200,
    teamHistoryJson: ['RCB']
  },
  {
    externalKey: 'rohit-sharma',
    fullName: 'Rohit Sharma',
    nationality: 'India',
    isOverseas: false,
    age: 37,
    playingRole: CricketRole.BATSMAN,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_SPIN,
    basePriceLakhs: 200,
    teamHistoryJson: ['DCH', 'MI']
  },
  {
    externalKey: 'suryakumar-yadav',
    fullName: 'Suryakumar Yadav',
    nationality: 'India',
    isOverseas: false,
    age: 34,
    playingRole: CricketRole.BATSMAN,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI', 'KKR']
  },
  {
    externalKey: 'david-warner',
    fullName: 'David Warner',
    nationality: 'Australia',
    isOverseas: true,
    age: 38,
    playingRole: CricketRole.BATSMAN,
    battingStyle: BattingStyle.LEFT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['DC', 'SRH']
  },
  {
    externalKey: 'jasprit-bumrah',
    fullName: 'Jasprit Bumrah',
    nationality: 'India',
    isOverseas: false,
    age: 31,
    playingRole: CricketRole.BOWLER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_FAST,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI']
  },
  {
    externalKey: 'rashid-khan',
    fullName: 'Rashid Khan',
    nationality: 'Afghanistan',
    isOverseas: true,
    age: 26,
    playingRole: CricketRole.BOWLER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_SPIN,
    basePriceLakhs: 200,
    teamHistoryJson: ['SRH', 'GT']
  },
  {
    externalKey: 'pat-cummins',
    fullName: 'Pat Cummins',
    nationality: 'Australia',
    isOverseas: true,
    age: 31,
    playingRole: CricketRole.BOWLER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_FAST,
    basePriceLakhs: 200,
    teamHistoryJson: ['KKR', 'DC', 'SRH']
  },
  {
    externalKey: 'yuzvendra-chahal',
    fullName: 'Yuzvendra Chahal',
    nationality: 'India',
    isOverseas: false,
    age: 34,
    playingRole: CricketRole.BOWLER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_SPIN,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI', 'RCB', 'RR', 'PBKS']
  },
  {
    externalKey: 'hardik-pandya',
    fullName: 'Hardik Pandya',
    nationality: 'India',
    isOverseas: false,
    age: 31,
    playingRole: CricketRole.ALL_ROUNDER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_FAST,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI', 'GT']
  },
  {
    externalKey: 'ravindra-jadeja',
    fullName: 'Ravindra Jadeja',
    nationality: 'India',
    isOverseas: false,
    age: 36,
    playingRole: CricketRole.ALL_ROUNDER,
    battingStyle: BattingStyle.LEFT_HAND,
    bowlingStyle: BowlingStyle.LEFT_ARM_SPIN,
    basePriceLakhs: 200,
    teamHistoryJson: ['RR', 'KTK', 'CSK', 'GL']
  },
  {
    externalKey: 'andre-russell',
    fullName: 'Andre Russell',
    nationality: 'West Indies',
    isOverseas: true,
    age: 36,
    playingRole: CricketRole.ALL_ROUNDER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_FAST,
    basePriceLakhs: 200,
    teamHistoryJson: ['DC', 'KKR']
  },
  {
    externalKey: 'sunil-narine',
    fullName: 'Sunil Narine',
    nationality: 'West Indies',
    isOverseas: true,
    age: 36,
    playingRole: CricketRole.ALL_ROUNDER,
    battingStyle: BattingStyle.LEFT_HAND,
    bowlingStyle: BowlingStyle.RIGHT_ARM_SPIN,
    basePriceLakhs: 200,
    teamHistoryJson: ['KKR']
  },
  {
    externalKey: 'ms-dhoni',
    fullName: 'MS Dhoni',
    nationality: 'India',
    isOverseas: false,
    age: 43,
    playingRole: CricketRole.WICKET_KEEPER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['CSK', 'RPS']
  },
  {
    externalKey: 'rishabh-pant',
    fullName: 'Rishabh Pant',
    nationality: 'India',
    isOverseas: false,
    age: 27,
    playingRole: CricketRole.WICKET_KEEPER,
    battingStyle: BattingStyle.LEFT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['DC', 'LSG']
  },
  {
    externalKey: 'jos-buttler',
    fullName: 'Jos Buttler',
    nationality: 'England',
    isOverseas: true,
    age: 34,
    playingRole: CricketRole.WICKET_KEEPER,
    battingStyle: BattingStyle.RIGHT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI', 'RR', 'GT']
  },
  {
    externalKey: 'nicholas-pooran',
    fullName: 'Nicholas Pooran',
    nationality: 'West Indies',
    isOverseas: true,
    age: 29,
    playingRole: CricketRole.WICKET_KEEPER,
    battingStyle: BattingStyle.LEFT_HAND,
    bowlingStyle: BowlingStyle.NONE,
    basePriceLakhs: 200,
    teamHistoryJson: ['MI', 'PBKS', 'SRH', 'LSG']
  }
];

async function main() {
  console.log('Seeding AuctionCraze baseline master players...');
  for (const player of INITIAL_PLAYERS) {
    await prisma.masterPlayer.upsert({
      where: { externalKey: player.externalKey },
      update: {
        fullName: player.fullName,
        nationality: player.nationality,
        isOverseas: player.isOverseas,
        age: player.age,
        playingRole: player.playingRole,
        battingStyle: player.battingStyle,
        bowlingStyle: player.bowlingStyle,
        basePriceLakhs: player.basePriceLakhs,
        teamHistoryJson: player.teamHistoryJson
      },
      create: player
    });
  }
  console.log(`Seeded ${INITIAL_PLAYERS.length} baseline master players.`);
}

main()
  .catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
