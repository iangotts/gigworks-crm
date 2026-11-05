import { createContext, useContext } from 'react';

/** The band being worked in. Templates fill {band} from this. */
export const BandContext = createContext<string>('');
export const useBandName = (): string => useContext(BandContext);
