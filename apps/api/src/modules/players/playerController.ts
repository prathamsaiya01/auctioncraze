import { Request, Response, NextFunction } from 'express';
import { CricketRole, prisma } from '@auctioncraze/database';

export class PlayerController {
  static async listCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const role = typeof req.query.role === 'string' ? req.query.role.trim().toUpperCase() : '';
      const overseasParam = req.query.overseas;

      const where: any = { isActive: true };
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { nationality: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (role && Object.values(CricketRole).includes(role as CricketRole)) {
        where.playingRole = role as CricketRole;
      }
      if (overseasParam === 'true') where.isOverseas = true;
      if (overseasParam === 'false') where.isOverseas = false;

      const players = await prisma.masterPlayer.findMany({
        where,
        orderBy: [{ basePriceLakhs: 'desc' }, { fullName: 'asc' }],
        take: 100
      });

      res.json({
        success: true,
        data: players.map((p) => ({
          id: p.id,
          externalKey: p.externalKey,
          fullName: p.fullName,
          nationality: p.nationality,
          isOverseas: p.isOverseas,
          age: p.age,
          playingRole: p.playingRole,
          battingStyle: p.battingStyle,
          bowlingStyle: p.bowlingStyle,
          basePriceLakhs: p.basePriceLakhs,
          imageUrl: p.imageUrl
        }))
      });
    } catch (err) {
      next(err);
    }
  }
}
