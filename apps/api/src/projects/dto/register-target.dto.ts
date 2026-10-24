import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  Equals,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class RegisterTargetDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  baseUrl!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  approvedDomains!: string[];

  @Equals(true)
  authorizationConfirmed!: true;
}
